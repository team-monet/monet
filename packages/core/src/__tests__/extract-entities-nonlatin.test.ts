/**
 * Non-Latin entity extraction (#187), plus the first automated check that src/extract-entities.mjs
 * has not drifted from src/extract-entities.ts.
 *
 * WHY THE MIRROR CHECK LIVES HERE: extract-entities.mjs's own module doc claims its logic is "a
 * byte-for-byte mirror" and that "if that module's extraction logic ever changes, this mirror must
 * change identically" — but nothing enforced it. src/db-slugify.mjs has exactly such a test
 * (db-slugify.test.ts) and that file's doc even cites extract-entities.mjs as the precedent for the
 * pattern, which is how the gap stayed invisible. The mirror is not cosmetic: scripts/scrub-db.mjs
 * uses it to decide which entity rows to PRUNE after redaction, so a drifted mirror prunes against
 * a token set the live engine never produced.
 *
 * The fixtures below are shared by both halves deliberately — every behavioral case is also a
 * parity case, so a change made to one file and not the other fails here rather than in production.
 */
import { describe, it, expect } from "vitest";
// EXPLICIT .ts EXTENSION, and it is load-bearing. Vite/vitest's default resolve order puts `.mjs`
// AHEAD of `.ts`, while esbuild (tsup, which builds what ships) does not resolve `.mjs` at all —
// so the extensionless `../extract-entities` that engine.ts uses means the MIRROR under test and
// the REAL module in production. Importing it extensionless here would make every assertion below
// an assertion about the mirror, and the parity check a comparison of one file with itself.
// Verified by probe, not assumed: breaking `.ts` alone left all of these green.
import { extractEntities as real } from "../extract-entities.ts";
// @ts-expect-error — plain .mjs mirror, no type declarations; imported for its pure function only.
import { extractEntities as mirrored } from "../extract-entities.mjs";

const FIXTURES: Array<[string, string]> = [
  ["korean", "주식 트래커 포트폴리오를 정리했다"],
  ["korean-inflected", "주식을 트래커에서 포트폴리오를 봤다"],
  ["korean-spaced-particle", "AuthService 에서 토큰을 갱신한다"],
  ["korean-strip-guards", "마을 가을 사과 지도"],
  ["japanese", "株式トラッカーのポートフォリオを整理した"],
  ["chinese", "股票追踪器投资组合整理"],
  ["thai", "จัดระเบียบพอร์ตโฟลิโอตัวติดตามหุ้น"],
  ["russian", "Организовал портфель трекера акций"],
  ["arabic", "تنظيم محفظة متتبع الأسهم"],
  ["english", "we ran the migrations and more migration work"],
  ["english-structural", "the AuthService change in src/engine.ts threw ECONNREFUSED"],
  ["contractions", "it's that's there's o'clock don't fine"],
  ["numerics", "shipped 123 in 2026 with 3.14 coverage"],
  ["hebrew", "שם יד לב ים"],
  ["hindi", "की घर"],
  ["greek", "γη ως"],
  ["dotted-unicode", "café.ts and файл.ts and plain café"],
  ["mixed-script", "AuthService 를 使って 포트폴리오 tracker"],
  ["empty", ""],
  ["punctuation-only", "!!! ... ---"],
];

const keys = (s: string): string[] => real(s).map((e) => e.key);

describe("extractEntities — non-Latin scripts produce entities at all (#187)", () => {
  it("extracts from every script that previously produced NOTHING", () => {
    // Each of these returned [] before the ICU segmenter replaced the [a-z] word regex.
    expect(keys("주식 트래커 포트폴리오")).toContain("noun:주식");
    expect(keys("株式トラッカーのポートフォリオ")).toContain("noun:株式");
    expect(keys("股票追踪器投资组合")).toContain("noun:股票");
    expect(keys("Организовал портфель")).toContain("noun:портфель");
    expect(keys("تنظيم محفظة")).toContain("noun:محفظة");
  });

  it("keeps two-character CJK content words, which the 3-char floor alone would erase", () => {
    // The whole Chinese sentence segments into two-character words; a length>=3 floor takes the
    // entity count straight back to zero, so fixing only the tokenizer would not have fixed #187.
    const chinese = keys("股票追踪器投资组合整理");
    expect(chinese.length).toBeGreaterThanOrEqual(4);
    expect(chinese.every((k) => k.startsWith("noun:"))).toBe(true);
  });

  it("keeps two-character content words in EVERY non-Latin script, not a listed few (Codex review, PR #189)", () => {
    // The first version enumerated Han/Hiragana/Katakana/Hangul and read as "every script" while
    // silently dropping Hebrew שם, Hindi की and Greek γη — ordinary nouns. The floor is now stated
    // as the English rule it is (Latin only), which has no "you forgot one" failure mode.
    expect(keys("שם יד לב ים")).toEqual(expect.arrayContaining(["noun:שם", "noun:יד"]));
    expect(keys("की घर")).toEqual(expect.arrayContaining(["noun:की", "noun:घर"]));
    expect(keys("γη ως")).toEqual(expect.arrayContaining(["noun:γη"]));
    // ...and Latin-script languages that are not English, which a `\p{Script=Latin}` floor also
    // discarded (Codex review, PR #189, round 5). There is no script test left: the floor is two
    // everywhere and the English-specific knowledge lives in STOPWORDS, where it belongs.
    expect(keys("los os y la fe con Ei und cá")).toEqual(
      expect.arrayContaining(["noun:os", "noun:fe", "noun:ei", "noun:cá"]),
    );
    // ...while the English function words still go, because they are listed rather than measured.
    expect(keys("it is at an of to")).toEqual([]);
  });

  it("drops two-letter ENGLISH function words the old floor used to hide (Codex review, PR #189)", () => {
    // Removing the floor removed the implicit filtering it was doing; STOPWORDS is where the
    // explicit filtering belongs. This test exists because the check that was supposed to prove it
    // ran while the floor was still 3, so it could not tell "already in STOPWORDS" from "dropped by
    // the floor" and reported a clean result. Asserted here at the real floor.
    for (const w of ["he", "me", "us", "am", "go", "id", "ok", "vs", "oh", "ah", "hi", "um", "er"]) {
      expect(keys(w + " thing")).not.toContain("noun:" + w);
    }
    // And the non-English two-letter words this floor change existed to keep are still kept.
    for (const w of ["os", "fe", "ei", "cá"]) {
      expect(keys(w + " 것")).toContain("noun:" + w);
    }
  });

  it("splits a non-Latin filename instead of making an entity of it (Codex review, PR #189)", () => {
    // The structural path patterns are ASCII-only, so "café.ts" reached the noun pass intact and
    // singularize took its trailing s, emitting `noun:café.t` — which also failed to share a key
    // with a plain mention of café.
    const k = keys("café.ts and файл.ts and plain café");
    expect(k).not.toContain("noun:café.t");
    expect(k).toContain("noun:café"); // the SAME key a plain mention produces
    expect(k).toContain("noun:файл");
  });

  it("segments scripts that have no spaces at all", () => {
    // Thai is written without word separators — no character class can split it.
    expect(keys("จัดระเบียบตัวติดตามหุ้น").length).toBeGreaterThan(1);
  });
});

describe("extractEntities — Korean particle normalization is what makes entities link", () => {
  it("converges inflected and bare forms onto the SAME entity keys", () => {
    const bare = keys("주식 트래커 포트폴리오");
    const inflected = keys("주식을 트래커에서 포트폴리오를 봤다");
    for (const k of bare) expect(inflected).toContain(k);
  });

  it("never strips a particle-shaped syllable off a word that needs it", () => {
    // 마을/가을 end in 을 and 사과 ends in 과 without containing a particle. The two-syllable
    // floor is the guard; without it each would lose its last syllable.
    const k = keys("마을 가을 사과 지도");
    expect(k).toEqual(expect.arrayContaining(["noun:마을", "noun:가을", "noun:사과", "noun:지도"]));
  });

  it("drops a particle standing alone as its own token", () => {
    // Korean spacing puts one on its own often enough that it leaked as a noun.
    expect(keys("AuthService 에서 토큰을 갱신한다")).not.toContain("noun:에서");
  });
});

describe("extractEntities — Latin behavior is unchanged", () => {
  it("still singularizes, still drops stopwords", () => {
    const k = keys("we ran the migrations and more migration work");
    expect(k).toContain("noun:migration");
    expect(k).not.toContain("noun:the");
    expect(k).not.toContain("noun:migrations");
  });

  it("does not turn contractions into bogus entities (Codex review, PR #189)", () => {
    // ICU keeps "it's" together as one word, so it missed the stopword check and singularize
    // stripped its trailing s, emitting `noun:it'`. Splitting on the apostrophe reproduces what
    // the old regex did by being unable to match one.
    const k = keys("it's that's there's fine");
    expect(k).not.toContain("noun:it'");
    expect(k).not.toContain("noun:that'");
    expect(k).not.toContain("noun:there'");
    expect(k).toContain("noun:fine");
    // The parts still count when they carry meaning, exactly as before.
    expect(keys("at o'clock")).toContain("noun:clock");
  });

  it("normalizes so a composed and a decomposed spelling share ONE entity key (Codex review, PR #189)", () => {
    // The entity key is the join column for `about` edges, so two spellings of the same word would
    // otherwise never link the concepts that mention it.
    // BUILT FROM CODE POINTS, not written as two literals. A source file can be normalized on its
    // way to disk, collapsing the two "different" spellings into identical bytes — the first
    // version of this test did exactly that, and passed while testing nothing.
    const composed = "caf" + String.fromCharCode(0x00e9) + " culture";     // e-acute as one code point
    const decomposed = "cafe" + String.fromCharCode(0x0301) + " culture";  // e + combining acute
    expect(composed).not.toBe(decomposed);
    expect(keys(composed)).toEqual(keys(decomposed));
  });

  it("does not turn numbers into entities (Codex review, PR #189)", () => {
    // isWordLike is true for numerals, so dates/counts/versions became entities and could link
    // wholly unrelated concepts. The module's contract has always been to drop numeric tokens.
    const k = keys("shipped 123 in 2026 with 3.14 coverage");
    expect(k).not.toContain("noun:123");
    expect(k).not.toContain("noun:2026");
    expect(k).not.toContain("noun:3.14");
    expect(k).toEqual(expect.arrayContaining(["noun:shipped", "noun:coverage"]));
  });

  it("still emits structural entities and does not re-emit them as nouns", () => {
    const k = keys("the AuthService change in src/engine.ts threw ECONNREFUSED");
    expect(k).toContain("id:AuthService");
    expect(k).toContain("err:ECONNREFUSED");
    expect(k).toContain("path:src/engine.ts");
    expect(k).not.toContain("noun:authservice");
  });
});

describe("extract-entities.mjs mirror — identical output to the real extractor", () => {
  it.each(FIXTURES)("%s", (_name, input) => {
    expect(mirrored(input)).toEqual(real(input));
  });

  it("is not a vacuous comparison — the shared fixtures do produce entities", () => {
    const produced = FIXTURES.filter(([, input]) => real(input).length > 0);
    expect(produced.length).toBeGreaterThanOrEqual(FIXTURES.length - 2); // empty + punctuation-only
  });
});
