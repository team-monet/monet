/**
 * THE LEXICAL ARM of native retrieval (#155) — the pure half.
 *
 * WHY A SECOND SIGNAL AT ALL. Nomination and search both reduce to top-1/top-k over every concept in
 * a circle, and on the live corpus one embedding space cannot make that choice: measured by
 * leave-one-out replay over 275 concepts, max-cosine returns an observation to its own concept 46.3%
 * of the time. Raising or lowering tauAttach does not move it (46-49% across 0.50-0.75), and neither
 * does removing the over-absorbed concepts (46.7% with blobs excluded from both sides). The signal,
 * not the threshold and not the corpus, is the binding constraint.
 *
 * WHY LEXICAL AND NOT ENTITIES. `concept_entities` was the expected answer — it already exists and is
 * densely populated (53,793 entities over 630 concepts). Measured on the same replay it scores 21.1%,
 * WORSE than cosine alone, and 47.5% in combination: those entities are spread too evenly to separate
 * anything. Plain IDF-weighted token overlap scores 53.2% by itself — beating the embedding — and
 * cosine × (1 + 0.5 × lexical) scores 59.1% when overlap is taken against a concept's token union, and 67.1% when it is taken per observation and maxed — the unit rule this file's lexicalOverlap note explains.
 *
 * THE BLEND WEIGHT IS DELIBERATELY MODEST AND DELIBERATELY NOT PRESENTED AS TUNED. 0.5 measured
 * 59.1% and 1.0 measured 57.5% across 739 replays, a gap inside the ~1.8pt standard error, so the
 * sweep resolves the SHAPE and not the number: a modest boost on top of cosine wins, while
 * lexical-dominant (54.0%) and evenly-weighted (55.5%) blends both score lower. Anyone changing it
 * should re-run scripts/measure-nomination-signals.ts on the corpus it will govern rather than
 * treating this constant as optimal.
 *
 * DOCUMENT FREQUENCY IS COUNTED OVER CONCEPTS, NOT OBSERVATIONS. A term every concept mentions must
 * not be able to decide anything, and on a single-project store that describes most of the domain
 * vocabulary — "monet", "store", "concept". Counting over observations would let a term that appears
 * many times inside ONE concept look rare, which is exactly backwards for a signal whose whole job is
 * to tell concepts apart.
 *
 * PURE: no db handle, no clock. The SQL that feeds it lives in retrieval.ts.
 */

/**
 * Words worth matching on, in TWO classes — because one regex cannot serve both scripts (#38).
 *
 * LATIN/DIGIT. Three characters minimum after the first, which drops the articles and operators that
 * carry no discriminative load, and keeps identifiers (`tauAttach`, `source_chunks`) whole — those
 * are the highest-signal tokens in a technical corpus and splitting them on case or underscore would
 * scatter exactly the evidence this arm exists to catch.
 *
 * CJK, CHARACTER BIGRAMS OVER A RUN. `[a-z0-9]` matches nothing in Han, Hangul, Hiragana or
 * Katakana, so before #38 the whole arm was blind to those scripts: a Korean probe yielded zero
 * tokens, `applyLexicalArm` short-circuited, and `lexicalCoverage` read 0.0 — which also held the
 * write-side ambiguity gate shut (see LEXICAL_COVERAGE_MIN). Bigrams rather than whole runs because
 * these scripts do not delimit words: Korean spaces at the *eojeol* (word+particle) boundary and
 * Chinese and Japanese do not space at all, so a run is a phrase and matching whole runs would only
 * match identical phrasing. Bigrams are the standard CJK fallback for exactly this reason — they
 * need no dictionary, no morphological analyser and no model, which keeps this arm what its header
 * says it is: pure, synchronous, and dependency-free.
 *
 * A ONE-CHARACTER RUN IS DROPPED, NOT EMITTED AS A UNIGRAM — the same rule the Latin class already
 * applies to `a` and `to`, reached the same way. Single Hangul syllables between spaces are almost
 * all grammatical (이/그/수/것/때), and single Han characters in Korean and Japanese prose are
 * mostly counters and particles. MEASURED, not assumed: see the CJK_GRAM block below for the
 * corpus run that decided it against the emit-as-unigram alternative.
 */
const LATIN_TOKEN = "[a-z0-9][a-z0-9_-]{2,}";

/**
 * One CJK character: in Han, Hangul, Hiragana or Katakana AND a letter or digit.
 *
 * SCRIPT EXTENSIONS (`scx`), not `sc`, so the marks these scripts share with Common travel with the
 * run they belong to — the prolonged sound mark `ー` (U+30FC) and the iteration mark `々` (U+3005)
 * are `Script=Common` and would otherwise split `データー` and `人々` in half.
 *
 * INTERSECTED WITH `[\p{L}\p{N}]` by the lookahead, and that is load-bearing rather than tidy:
 * `lexicalCoverage`'s denominator counts letters and digits, so a run admitting CJK punctuation
 * would put characters in the numerator that the denominator never counted. Punctuation also ends a
 * run, which is what keeps a bigram from spanning `。` and joining two sentences.
 */
const CJK_CHAR = "(?=[\\p{L}\\p{N}])[\\p{scx=Han}\\p{scx=Hangul}\\p{scx=Hiragana}\\p{scx=Katakana}]";

/**
 * A combining or variation mark sitting INSIDE a CJK run, admitted so it cannot split one, then
 * DROPPED before grams are cut (Codex P2, PR #97 round 4).
 *
 * WHY NFC IS NOT ENOUGH. `prepare` composes what Unicode can compose, and for the common Kana case
 * that is everything: か + U+3099 becomes が, one character, one gram. But composition is only
 * defined where a precomposed character EXISTS. Two shapes have none, and both are valid text:
 *
 *   セ + U+309A — the Ainu semi-voiced katakana. NFC leaves it decomposed because there is no
 *   precomposed `セ゚`, and U+309A is `Mn`, not a letter, so the old class rejected it and split
 *   `セ゚ト` into two one-character runs. Both were then dropped by the lone-run rule and the text
 *   emitted NOTHING, where plain `セト` emits one bigram.
 *
 *   見 + U+E0100 — an ideographic variation selector, used to pin a glyph in Han names. Also `Mn`,
 *   also NFC-stable, same split, same silence. (Note it is `Inherited`, not `scx=Han`, so widening
 *   the script class would not have caught it — this has to be a mark class.)
 *
 * DROPPED RATHER THAN CARRIED, and the reason is the gram invariant. A gram is CJK_GRAM BASE
 * characters; carrying a mark into one would make `セ゚ト` a three-code-point "bigram" that no other
 * spelling of the same text can equal, so mark-carrying and plain spellings would stop matching each
 * other — which is the defect, relocated rather than fixed. Dropping makes them match, and it is
 * what a variation selector deserves outright: it selects a glyph, not a meaning, so a search for 見
 * should find 見 with any selector on it. The one thing dropping gives up is telling `セ゚` from `セ`,
 * and that is a distinction NFC already keeps wherever Unicode gives it a character to keep it in.
 *
 * A run must still START with a real CJK character, so a stray mark after Latin or punctuation opens
 * nothing. Marks are `[\p{L}\p{N}]`-negative, so they were never in `lexicalCoverage`'s denominator
 * and must not reach its numerator either — `scanLexical` counts base characters only.
 *
 * ALL OF `\p{M}`, NOT JUST `\p{Mn}\p{Me}` (Codex P2, PR #97 round 7). Combining marks are not all
 * non-spacing: the Hangul tone marks `U+302E`/`U+302F` and the ideographic tone marks
 * `U+16FF0`/`U+16FF1` are category `Mc`, and all four are script-attached to the very scripts this
 * class exists for — `scx=Hangul` and `scx=Han` respectively. Excluding `Mc` split `한` + U+302E +
 * `국` into two one-character runs and emitted nothing, the same defect the `Mn` cases had.
 *
 * BLANKET `\p{M}` IS SAFE, and the reason is a property of Unicode rather than a survey of what
 * happens to be adjacent to CJK in practice. General categories are MUTUALLY EXCLUSIVE, so no mark
 * is ever a letter or a number: verified exhaustively over all 0x110000 code points, 0 of the 2543
 * `\p{M}` characters are also `[\p{L}\p{N}]`. Marks therefore cannot reach the coverage
 * denominator no matter how many of them this class admits, and the counting invariant is untouched
 * by construction. Widening past `Mn`/`Me` adds 471 `Mc` characters; 4 are the CJK tone marks above
 * and the rest are Indic and South-East Asian spacing vowel signs, which can only be absorbed when
 * they sit DIRECTLY AFTER a CJK base — text that is already malformed, where the outcome is bounded
 * to dropping the mark and treating the two CJK characters either side of it as adjacent.
 */
const CJK_MARK = "\\p{M}";

/**
 * SPACING MODIFIERS THAT ARE NOT MARKS AT ALL (Codex P2, PR #97 round 8). `\p{M}` still misses the
 * spacing dakuten `U+309B` and handakuten `U+309C`, because Unicode classifies them as `Sk` — modifier
 * SYMBOLS, not marks — even though they are `scx=Hiragana`/`scx=Katakana` and annotate the character
 * before them exactly as their combining twins `U+3099`/`U+309A` do. NFC leaves them alone, so
 * `か` + U+309B + `き` split into two dropped runs and emitted nothing.
 *
 * THE CARVE-OUT IS THE WHOLE CATEGORY, NOT THE TWO CHARACTERS THAT WERE REPORTED. Sweeping every
 * code point whose Script_Extensions name a CJK script and which the class does not already admit
 * returns 794, and they sort cleanly: 743 are `So` Kangxi RADICAL forms (U+2E80…), which are bases
 * rather than modifiers and do not occur in running prose; ~40 are punctuation (`Po`/`Ps`/`Pe`/`Pd`,
 * including `、`, `。`, `・` and the halfwidth `｡｢｣`) which must keep breaking runs; and 13 are `Sk`
 * — U+309B/U+309C here, the Bopomofo tone marks U+02D9/U+02EA/U+02EB, and the Chinese tone letters
 * U+A700–U+A707. Those 13 are one kind of thing: a spacing annotation on the preceding base. Taking
 * the category rather than the pair is what makes this complete. (Iteration marks `々ヽヾゝゞ` never
 * appear in that sweep — they are `Lm`, and `\p{L}` has always admitted them.)
 */
const CJK_SPACING_MODIFIER =
  "(?=\\p{Sk})[\\p{scx=Han}\\p{scx=Hangul}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Bopomofo}]";

/**
 * DECIMAL DIGITS CONTINUE A RUN BUT NEVER START ONE (Codex P2, PR #97 round 8). Digits are
 * `Script_Extensions=Common`, so they satisfy the `[\p{L}\p{N}]` half of CJK_CHAR's intersection and
 * fail the script half — which cut `第3章` and `제3장` into three one-character runs and emitted
 * nothing at all. Numbered terms like these are ordinary Korean and Japanese, not edge cases.
 *
 * CONTINUATION ONLY, and the asymmetry is the point: a digit cannot open a run, so a bare number is
 * still the Latin class's business and nothing about the `[a-z0-9]` contract moves. Punctuation
 * between a digit and a character still breaks the run, because only these classes continue it.
 *
 * KEPT IN THE GRAM, unlike the marks above — `第3章` yields `第3` and `3章`. A chapter number is
 * evidence, not decoration, and dropping it would make every numbered section of a document collide.
 * Digits are `\p{N}`, so they are in `lexicalCoverage`'s denominator already and being read by a gram
 * is what keeps the numerator honest about them.
 */
const CJK_DIGIT = "\\p{Nd}";

/** One character to strip from a matched run: marks and spacing modifiers, never digits. */
const CJK_STRIP_ONE =
  /\p{M}|(?=\p{Sk})[\p{scx=Han}\p{scx=Hangul}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Bopomofo}]/u;

/**
 * ONE PASS, BOTH CLASSES. Alternation rather than two independent scans, so every character of the
 * text is claimed by at most one branch and `scanLexical` below can count coverage off the same walk
 * that emits the tokens. Two scans would let the two measures drift apart, which is the failure the
 * counting invariant in `lexicalCoverage` exists to prevent.
 */
const LEXICAL_SCAN = new RegExp(
  `(?<latin>${LATIN_TOKEN})|(?<cjk>${CJK_CHAR}(?:${CJK_CHAR}|${CJK_MARK}|${CJK_SPACING_MODIFIER}|${CJK_DIGIT})*)`,
  "gu",
);

/** Letters and digits — `lexicalCoverage`'s denominator, and the class `CJK_CHAR` intersects with. */
const ALNUM = /[\p{L}\p{N}]/gu;

/**
 * The gram width for CJK, and the minimum run length that yields anything at all: a run shorter than
 * this is read by nothing and therefore counts as nothing.
 *
 * MEASURED, AND THE MEASUREMENT IS MIXED — read this before treating the CJK branch as settled.
 * Space `Xenova/bge-m3:cls:q8` 1024-dim, corpus `cjk-corpus-2026-08-26` (1285 live observations,
 * 161 concepts, 75.3% CJK-heavy), 2026-08-26, leave-one-out concept recall at LEXICAL_BOOST 1.0.
 * `segment -> segment+lexical` R@1 on CJK-heavy queries, this tokenizer against the retired one:
 *
 *   query shape          n     retired    this    R@5 (retired -> this)
 *   full observation   967      +7.2pp   +5.3pp    88.6% -> 90.6%
 *   opening sentence   830      +5.3pp   +6.7pp    70.8% -> 78.4%
 *
 * THE FULL-OBSERVATION CELL IS A REGRESSION AGAINST THE RETIRED TOKENIZER (63.4% -> 61.4%, net -19
 * of 967, McNemar p=0.113) and it has one mechanism: `lexicalOverlap` normalises by the PROBE's
 * total IDF mass, so the ~7 high-IDF Latin identifiers a Korean technical observation carries stop
 * being the whole denominator once ~115 CJK bigrams join it, and a candidate sharing the identifier
 * earns a smaller overlap than before. Split by how much Latin the CJK-heavy probe carries, the two
 * effects separate cleanly (full observation, delta against segment-only):
 *
 *   Latin tokens >= 3    n=771    retired +9.7pp    this +6.2pp
 *   Latin tokens 1-2     n=133    retired -3.8pp    this +0.8pp
 *   Latin tokens == 0    n= 63    retired +0.0pp    this +3.2pp
 *
 * So the pooled anchor is carried by a subgroup where the retired tokenizer already worked, and this
 * branch strictly wins on the population #38 exists for — where the retired arm was inert (+0.0pp)
 * or actively harmful (-3.8pp). Both readings are true; neither alone is the number.
 *
 * WIDTH AND LONE-RUN RULE, against the alternatives swept on the same corpus (CJK-heavy R@1,
 * full observation / opening sentence, and the share of CJK-heavy observations clearing
 * LEXICAL_COVERAGE_MIN, which is what decides whether the write gate can evaluate at all):
 *
 *   bigrams, lone run dropped   61.4% / 49.2%   99.4% over the bar   <- this
 *   bigrams, lone run unigram   60.7% /    -    99.9%
 *   trigrams                    61.8% / 48.0%    0.0%
 *   4-grams                     61.3% /    -     0.0%
 *   unigrams only               62.6% /    -    99.9%
 *   bigrams + trigrams          60.5% /    -    99.4%
 *   bigrams, runs >= 3 only     61.2% / 48.2%   99.4%
 *   bigrams, run tail trimmed   62.6% / 50.8%   33.6%
 *
 * Nothing beats the retired tokenizer on the full-observation cell. Unigrams come closest by
 * contributing almost nothing — their document frequency is so high that `tokenIdf` clamps them —
 * and they LOSE on the Latin-token-free population (-1.6pp), which is the one #38 names. Trigrams
 * and 4-grams score comparably on reading but leave 0% of CJK-heavy observations over the coverage
 * bar, because they emit nothing at all from the two-character runs Korean is full of, so they close
 * the read half of #38 while leaving the write half exactly as broken as before. Trimming a run's
 * last character (a crude Korean stem/particle split) reads best of all but costs two thirds of the
 * write gate, and this corpus is Korean-only, so it cannot certify a Korean morphological heuristic
 * for Han or Kana at all. Bigrams with the lone run dropped are what remains: the rule with no
 * language-specific assumption in it, winning the read half on short queries and the write half
 * outright.
 *
 * RAISING LEXICAL_BOOST DOES NOT RECOVER THE FULL-OBSERVATION CELL — swept 0.15 to 2.0, CJK-heavy
 * R@1 rises monotonically to 62.9% at 2.0 and still does not reach the retired tokenizer's 63.4% at
 * 1.0, while Latin degrades above 0.5. The dilution explains the direction; the blend weight is not
 * the lever that undoes it.
 *
 * WHAT THIS CORPUS CANNOT SAY. It is Korean. Han and Kana appear only incidentally, so the width and
 * the lone-run rule are certified for Hangul and inferred for the rest — a Chinese or Japanese
 * corpus would have runs an order of magnitude longer (no inter-word spacing) and might well choose
 * differently.
 */
const CJK_GRAM = 2;

/**
 * The single walk both public functions read: the tokens a text yields, and how many of its letters
 * and digits those tokens actually read.
 *
 * COUNTED THE SAME WAY ON BOTH SIDES (Codex P2, PR #87 round 5, generalised for #38). The rule is
 * that a character counts as covered exactly when some EMITTED token contains it, counted once
 * however many tokens that is. Two ways to break it, one per class:
 *
 *   LATIN — `m[0].length` includes the `-` and `_` a token may carry, while the denominator counts
 *   letters and digits only, so `api____________________` reported more covered characters than it
 *   has readable ones and could push a mostly-CJK probe to full coverage on three ASCII letters.
 *
 *   CJK — bigrams OVERLAP, so a run of n characters emits n-1 tokens totalling 2(n-1) characters.
 *   Summing token lengths would report 1.33x coverage on a three-character run and let `Math.min`
 *   quietly absorb the error, which is the same defect wearing the other script's clothes. The run
 *   contributes n, because each of its n characters is read, once.
 *
 * Takes text ALREADY prepared by `prepare` below — normalised and lowercased. That is not a caller
 * convenience: `lexicalCoverage`'s denominator has to be counted over the very same string this
 * walks, and NFC changes how many code points a text has.
 */
function scanLexical(lower: string): { tokens: string[]; covered: number } {
  const tokens: string[] = [];
  let covered = 0;
  for (const m of lower.matchAll(LEXICAL_SCAN)) {
    const latin = m.groups?.latin;
    if (latin !== undefined) {
      tokens.push(latin);
      covered += (latin.match(ALNUM) ?? []).length;
      continue;
    }
    // Code points, not UTF-16 units: CJK Extension B and beyond are astral, and a bigram cut at a
    // surrogate boundary is a token no other text can ever match. Marks were admitted by the scan so
    // they could not split the run; they are dropped here so grams stay a fixed number of BASE
    // characters and so `covered` counts only what the denominator counts. See CJK_MARK.
    const run = [...(m.groups?.cjk ?? "")].filter((c) => !CJK_STRIP_ONE.test(c));
    if (run.length < CJK_GRAM) continue; // read by nothing, so covered by nothing
    for (let i = 0; i + CJK_GRAM <= run.length; i++) tokens.push(run.slice(i, i + CJK_GRAM).join(""));
    covered += run.length;
  }
  return { tokens, covered };
}

/**
 * THE ONE ENTRY BOTH READERS GO THROUGH. Normalise, then lowercase — in that order, and once.
 *
 * NFC BECAUSE CANONICALLY EQUIVALENT TEXT MUST TOKENIZE IDENTICALLY (Codex P2, PR #97). Unicode
 * lets the same character be stored two ways, and the CJK class is far more exposed to it than the
 * Latin class ever was, because the decomposed form inserts a COMBINING MARK in the middle of a run:
 *
 *   `がき` composed (U+304C U+304D) is one two-character run and emits the bigram `がき`; decomposed
 *   (か U+3099 き) the combining dakuten is not in the CJK class, so it SPLITS the run into two
 *   one-character runs, each dropped by the lone-run rule — the text emits nothing at all.
 *
 *   Hangul is the same defect with a different shape: conjoining Jamo (ᄒ ᅡ ᆫ) are `scx=Hangul` and
 *   so are precomposed syllables (한), but a three-Jamo syllable is three characters where the
 *   syllable is one, so the two forms produce bigrams that can never match each other.
 *
 * Both forms occur in the wild — macOS filesystem APIs hand back NFD, most editors and git blobs
 * hold NFC — so a probe and the document it should match could disagree purely on encoding. NFC is
 * the composing direction, so it is the one that keeps a run whole.
 *
 * NORMALISE BEFORE LOWERCASING because composition is defined on the original characters; the
 * reverse order can leave a composed form unreachable. CJK has no case, so the second step is a
 * no-op for the class this fixes and the existing behaviour for the Latin one.
 *
 * NO LEGACY MISMATCH SURVIVES THIS. Postings written before #38 were produced without normalisation,
 * so a store could hold NFD-derived tokens that this now never emits — but `reindexLexicalTokens`
 * (engine.ts) regenerates every posting row from stored text at the first open that carries this
 * code, so both sides of every comparison come from this function or neither does.
 */
/**
 * HALF-WIDTH KATAKANA, FOLDED TO FULL WIDTH BEFORE ANYTHING ELSE (Codex P2, PR #97 round 8).
 *
 * NFC composes; it does not fold COMPATIBILITY width. So `ｶﾞｷ` (U+FF76 U+FF9E U+FF77, three code
 * points) and `ガキ` (U+30AC U+30AD, two) are the same text to a reader and NFC-stable to us, and
 * they tokenized to disjoint posting sets — `ｶﾞ`/`ﾞｷ` against `ガキ` — so neither could ever match
 * the other.
 *
 * THE DOMAIN IS EXACTLY U+FF66–U+FF9F: the halfwidth katakana letters, plus the halfwidth voiced and
 * semi-voiced sound marks U+FF9E/U+FF9F at the top of that range. Nothing else is touched.
 *
 * NOT NFKC ON THE WHOLE STRING, which would fold two things that must not fold. Full-width Latin
 * (`Ａ` -> `a`) would silently enter the `[a-z0-9]` token contract, so text nobody wrote in ASCII
 * would start matching ASCII identifiers. And halfwidth CJK punctuation — `｡` `｢` `｣` `､` `･`, which
 * sit at U+FF61–U+FF65, immediately below this range — must keep breaking runs, exactly as their
 * full-width forms do; folding them would still leave punctuation, but widening the domain to
 * include them buys nothing and costs the property that this fold touches only letters.
 *
 * PER CODE POINT, THEN COMPOSED. Each character in range is NFKC'd on its own — `ｶ` -> `カ`,
 * `ﾞ` -> U+3099, the COMBINING voiced mark — and `prepare`'s existing NFC pass then composes
 * `カ` + U+3099 into the single character `ガ`. So the three-code-point halfwidth spelling lands as
 * the two-code-point full-width one, and both cut the same gram.
 */
const HALFWIDTH_KANA = /[\uFF66-\uFF9F]/u;
const HALFWIDTH_KANA_ALL = /[\uFF66-\uFF9F]/gu;
const foldHalfwidthKana = (text: string): string =>
  HALFWIDTH_KANA.test(text) ? text.replace(HALFWIDTH_KANA_ALL, (c) => c.normalize("NFKC")) : text;

const prepare = (text: string): string => foldHalfwidthKana(text).normalize("NFC").toLowerCase();

/**
 * The share of a text's letters and digits that the tokenizer above actually consumes — "how much of
 * this can the lexical arm read", answered by the tokenizer itself.
 *
 * WHY NOT nonLatinLetterShare (Codex P1, PR #87 round 4). That function detects SCRIPT, and says so
 * in its own header: French, Vietnamese and Turkish score 0 there and are still largely invisible to
 * the tokenizer, whose Latin class is `[a-z0-9_-]`. Anything accented is dropped or fragmented.
 * Using the script guard to decide lexical comparability answered a neighbouring question — the
 * third time this branch reached for an adjacent quantity, which is why the measure now lives beside
 * the regex it measures rather than being borrowed from a module that documents its own
 * unsuitability. #38 widened the tokenizer, not this argument: a script guard would now be wrong in
 * a second direction as well, since it cannot see that CJK has become readable.
 */
/**
 * Below this share of a text readable by the tokenizer, a rank gap is not the quantity a
 * lexically-blended threshold was calibrated against, and any such threshold must stand down (see
 * tauMargin).
 *
 * THE VALUE DID NOT MOVE ACROSS #38. ITS JUSTIFICATION DID, ENTIRELY. What follows is the
 * re-derivation; the argument it replaces is quoted below it, retired rather than deleted, because
 * the reason a constant was chosen is the thing that goes stale when the space around it changes.
 *
 * RE-DERIVED 2026-08-26 — space `Xenova/bge-m3:cls:q8` 1024-dim, corpus `cjk-corpus-2026-08-26`
 * (1285 live observations over 161 concepts, 75.3% CJK-heavy, 83.8% carrying any CJK), tokenizer as
 * of this file's #38 CJK branch. Coverage by script class, `cjkShare` of the observation, re-measured
 * 2026-08-27 after the spacing-modifier, in-run-digit and halfwidth-Kana refinements:
 *
 *                          n     min    p01    p05    p50    p99   >= 0.8
 *   CJK-heavy (>0.5)     967   0.750  0.819  0.865  0.932  0.989   99.4%
 *     of which >0.8      343   0.827  0.863  0.888  0.946  0.990  100.0%
 *   mixed (0.2-0.5]       95   0.748  0.748  0.804  0.928  1.000   95.8%
 *   Latin (<=0.2)        223   0.856  0.863  0.893  0.940  0.979  100.0%
 *   ALL                 1285   0.748  0.813  0.863  0.934  0.989   99.2%
 *
 * THE POPULATIONS DID NOT SEPARATE — THEY CONVERGED, and that is what settles the per-script
 * question this constant raised. CJK-heavy text now lands where Latin text lands (medians 0.932 vs
 * 0.940), so one global constant serves both and no script-aware variant is needed. Before #38 the
 * same three classes read 0.205 / 0.540 / 0.938 at the median and 0.0% / 0.0% / 98.7% over the bar.
 *
 * LATIN IS UNTOUCHED, BY CONSTRUCTION AND BY MEASUREMENT — re-checked after every refinement since,
 * most recently 2026-08-27. All 208 observations with NO CJK at all score identical coverage and
 * identical token counts before and after — the CJK branch cannot fire
 * on them. The Latin CLASS moves (min 0.761 -> 0.856) only because `cjkShare <= 0.2` admits a little
 * CJK, and that little is now read.
 *
 * WHAT 0.8 NOW COSTS, because it is no longer free. It refuses 10 of 1285 observations (0.8%), 6 of
 * them CJK-heavy (0.6% of that class). That is the trade-off the retired argument did not have to
 * make, and the number to weigh against any proposal to move it.
 *
 * WHERE A FUTURE RE-DERIVATION WOULD GO. The empty band moved rather than vanishing: [0.571, 0.845)
 * held nothing on the English derivation population and holds 42 observations (3.3%) here, while
 * [0.571, 0.748) is empty on BOTH — above accented French (0.458-0.571 measured, still refused) and
 * below this corpus's minimum. A value in that band would admit 100% of every population measured so
 * far and still refuse the contrast cases, which is the same FORM of argument that originally chose
 * 0.8. It is not taken here because 0.8 already meets what #38 asked of it and moving a global
 * constant that governs English writes wants an English measurement demanding it, which there is
 * not.
 *
 * ── RETIRED 2026-08-26 (#38). True of the tokenizer that shipped before the CJK branch, and false
 * of this one — its Korean and Korean-plus-identifier contrast cases are now READ, at 1.000 and
 * 1.000, and its empty band is no longer empty:
 *
 *   "MEASURED, NOT PICKED. On the corpus tauMargin was derived from — monet-hq, n=1011 live
 *    observations, in the `Xenova/bge-small-en-v1.5` 384-dim space that store held BEFORE its
 *    2026-08-24 migration to bge-m3 (naming the space, not just the corpus, is the point: see the
 *    LEXICAL_BOOST block below for what a corpus-only label cost) — coverage runs min 0.845, p01
 *    0.902, p05 0.920, p50 0.955 — so every observation that produced the threshold clears this bar
 *    with room. The cases it has to exclude sit far below: Korean scores 0.000, Korean carrying an
 *    ASCII identifier 0.200, and accented French 0.571. The band between 0.571 and 0.845 is empty on
 *    both sides, and this sits inside it.
 *
 *    That emptiness is why the value is a floor rather than a tuned point: anywhere in that band
 *    admits 100% of the derivation population and refuses all three contrast cases, so nothing here
 *    is being traded off. Re-measure it on any corpus this threshold is re-derived against."
 *
 * The one instruction in it that survives unchanged is its last sentence, and this block is what
 * following it produced.
 */
export const LEXICAL_COVERAGE_MIN = 0.8;

export function lexicalCoverage(text: string): number {
  // Prepared ONCE, and the denominator counted over that same string. Counting `alnum` on the raw
  // text while the numerator walks the normalised one would reopen the counting invariant from the
  // other end: NFD `が` is two code points to the denominator and one to the tokenizer.
  const lower = prepare(text);
  const alnum = lower.match(ALNUM);
  if (alnum === null || alnum.length === 0) return 1; // nothing to read: vacuously comparable
  // The numerator comes from the same walk that emits the tokens — see scanLexical's header for the
  // invariant it exists to hold, and the two ways (one per script class) it has been broken.
  return Math.min(1, scanLexical(lower).covered / alnum.length);
}

/** The token set of one text. A SET, not a bag: this measures whether a term is shared, not how
 *  often it is repeated, so a long observation cannot outscore a short one by restating itself. */
/**
 * THE TOKENIZER-VERSION MARKER, written into `observation_tokens` beside every observation's real
 * postings (engine.ts, `writeObservationTokens`). Its presence is what tells a later open that a
 * row's postings came from THIS tokenizer; its absence is the only staleness signal the repair
 * needs, and the only one that does not depend on the writer having cooperated.
 *
 * IT LIVES HERE, NOT IN THE ENGINE, because its safety is a fact about this file: the marker must be
 * a string `lexicalTokens` can never emit, and only this file knows what it can emit.
 *
 * COLLISION-FREE BY A LEADING SPACE. Every token this module produces comes from exactly one of two
 * classes. Latin tokens match `[a-z0-9][a-z0-9_-]{2,}`, so every character is in `[a-z0-9_-]`. CJK
 * grams are cut from runs whose every character satisfies `[\p{L}\p{N}]`. U+0020 is in neither: it
 * is not in the Latin class's character set, and it is neither a letter nor a number. `prepare`
 * cannot introduce one either — NFC composes, and `toLowerCase` never produces a space from a
 * non-space. So no emitted token begins with, or contains, a space, and this value cannot be
 * mistaken for evidence.
 *
 * IT CARRIES THE VERSION, which is what makes a tokenizer bump self-executing: raise
 * LEXICAL_TOKENS_VERSION and every stored marker stops matching, so every row reads as stale and is
 * rebuilt, with no separate migration to write.
 */
export const lexicalTokensMarker = (version: number): string => ` lex:${version}`;

export function lexicalTokens(text: string): Set<string> {
  return new Set(scanLexical(prepare(text)).tokens);
}

/**
 * Inverse document frequency of one token, given how many of `conceptCount` concepts contain it.
 *
 * `1 + df` in the denominator so a token present in every concept still yields a positive weight
 * rather than a zero or a negative one — a token cannot be made to count AGAINST a concept, which is
 * what a raw log(N/df) would do once df exceeds N.
 */
export function tokenIdf(conceptCount: number, df: number): number {
  // CLAMPED AT ZERO (Codex P2, PR #156). The `1 + df` denominator was supposed to keep a ubiquitous
  // token from counting AGAINST a concept, and it does not: at df === conceptCount the log goes
  // negative, so a term every candidate shares would subtract weight, `lexicalOverlap` could fall
  // below zero, and a boosted rank could then sort UNDER an unboosted one. A term shared by
  // everything must be NEUTRAL, which is exactly zero and never less.
  return Math.max(0, Math.log(conceptCount / (1 + df)));
}

/**
 * How much of the incoming text's discriminative mass this concept accounts for: the IDF-weighted
 * fraction of the probe's own tokens that the concept also contains.
 *
 * APPLIED PER OBSERVATION, NEVER OVER A CONCEPT'S UNION — see the caller in retrieval.ts. A union
 * grows with concept size until a large concept contains nearly every term and overlaps everything at
 * ~1.0; measured, that cost small concepts 71.9% of their own evidence. Scored per observation and
 * maxed, the same corpus goes 59.1% -> 67.1% argmax accuracy.
 *
 * NORMALIZED BY THE PROBE, NOT BY THE UNION. A concept holding a hundred observations contains more
 * tokens than one holding two, and a Jaccard-style union denominator would penalise it for its size
 * regardless of relevance — reintroducing a size bias in the opposite direction to the one #155
 * started from. The question this answers is "how much of what arrived does this concept already
 * know", which is the question resolution is actually asking.
 *
 * Returns 0 when the probe carries no weighted tokens at all, so an empty or stopword-only text
 * contributes nothing rather than dividing by zero.
 */
export function lexicalOverlap(
  probeTokens: ReadonlySet<string>,
  conceptTokens: ReadonlySet<string>,
  idfOf: (token: string) => number,
): number {
  let matched = 0;
  let total = 0;
  for (const token of probeTokens) {
    const weight = idfOf(token);
    total += weight;
    if (conceptTokens.has(token)) matched += weight;
  }
  return total <= 0 ? 0 : matched / total;
}

/**
 * The blend: cosine, boosted by how much of the incoming text the concept already contains.
 *
 * MULTIPLICATIVE, NOT ADDITIVE, and that is measured rather than preferred. An additive blend
 * (0.5·cos + 0.5·lex) scores 59.4% against this form, because addition lets a concept with strong
 * vocabulary overlap and no semantic relationship win outright, while multiplication keeps cosine as
 * the floor of the decision and lets the lexical arm only re-order candidates that already have
 * semantic support. A concept the embedding rejects cannot be talked into winning by vocabulary.
 *
 * THE WEIGHT 1.0 HOLDS IN EVERY SPACE IT HAS BEEN MEASURED IN; THE SHAPE AROUND IT VARIES BY
 * SPACE — A PLATEAU'S START, A PEAK, OR A FLAT REGION'S TOP EDGE (all four runs below).
 * Measured at the shipped observation-unit overlap, argmax accuracy ran 0.5 -> 67.1%,
 * 1.0 -> 72.1%, 2.0 -> 72.7%, 4.0 -> 73.2% on the then-current embedder, and 72.8 / 73.9 / 74.2 /
 * 73.3 on bge-small-en — one plateau from 1.0 upward, inside the ~1.8pt standard error at n=739.
 * (This heading read "AND IS A PEAK ON THE ONE THAT SHIPS" until 2026-08-25; the run it rested on
 * turned out to be a bge-small run wearing a bge-m3 label. See the next paragraph.)
 *
 * TWO RUNS, TWO SPACES — AND THE FIRST ONE WAS MISLABELLED. This block used to report the
 * 2026-08-23 run as "RE-MEASURED ON bge-m3 (the shipping embedder)". It was not. That run reads
 * whatever vectors the DB it is pointed at holds (scripts/measure-nomination-signals.ts imports no
 * embedder), and monet-hq did not migrate to bge-m3 until 2026-08-24 09:51 UTC. Pointing the same
 * script at the pre-migration snapshot reproduces every figure to the decimal, which is what
 * settles it. Both runs, each against the space it actually read:
 *
 *   bge-small-en-v1.5, 384-dim, pre-migration monet-hq, 2026-08-23, n=788
 *     0 -> 66.0%, 0.25 -> 71.6%, 0.5 -> 72.8%, 1.0 -> 73.9%, 2.0 -> 72.8%, 4.0 -> 72.1%
 *   bge-m3:cls:q8, 1024-dim, post-migration monet-hq, 2026-08-25, n=788 (the space that SHIPS)
 *     0 -> 72.0%, 0.25 -> 75.6%, 0.35 -> 76.3%, 0.5 -> 76.3%, 1.0 -> 76.3%, 2.0 -> 75.8%,
 *     4.0 -> 75.1%
 *
 * The conclusion drawn from the mislabelled run — "there is no plateau in this space, accuracy
 * falls monotonically above 1.0, so 1.0 is the PEAK rather than a conservative point on a flat
 * region" — is TRUE OF bge-small AND FALSE OF bge-m3, and is retired as a statement about the
 * shipping space. In bge-m3, 0.35, 0.5 and 1.0 all tie at 76.3%: a genuine flat region, with 1.0
 * at its TOP edge. So 1.0 stands under both readings — the conservative-point argument that
 * originally chose it holds again in the space that ships, and there is still no measurement above
 * 1.0 that argues for raising it (2.0 and 4.0 fall in both spaces).
 *
 * The zero point was never measured before 2026-08-23: the lexical arm is worth +62 observations
 * (66.0% -> 73.9%) on bge-small and +34 (72.0% -> 76.3%) on bge-m3, and is net positive in every
 * home-concept size bin, so it earns its place in both — 21.8% of the residual misfiles at 1.0 are
 * won on a LOWER raw cosine, and that is the price of the gain rather than a defect to remove.
 *
 * An earlier draft of this file claimed 0.5 was optimal and that higher weights scored worse. That
 * came from measuring overlap against a concept's token UNION, whose size bias inverted the ordering.
 * At the unit this code actually uses, the ordering is the other way around.
 */
export const LEXICAL_BOOST = 1.0;

export function blendLexical(cosineScore: number, overlap: number): number {
  return cosineScore * (1 + LEXICAL_BOOST * overlap);
}
