/**
 * Cheap, deterministic, dependency-free entity extraction for short technical memory text
 * (#245, ADR §3.7). Entities are the anchors for `about` edges: two concepts that mention the
 * same RARE entity are linked. No NLP library — we want stable surface-form keys, not POS tags,
 * and the repo forbids new deps + non-determinism.
 *
 * Two passes:
 *   1. STRUCTURAL (high precision, case-sensitive, run first; matched spans removed so they
 *      aren't re-counted as nouns): file paths, camelCase/snake_case/dotted identifiers, error
 *      codes, and a curated library lexicon.
 *   2. NOUNS (lower precision): lowercase the residual, drop stopwords + short/numeric tokens,
 *      apply a conservative singularizer.
 *
 * Key form is `${kind}:${surface}` — e.g. `path:apps/api`, `lib:jose`, `id:AuthService`,
 * `err:ECONNREFUSED`, `noun:migration`. Whether a shared entity is strong enough to MATERIALIZE
 * an edge is decided in the engine (rarity / hub gate), not here.
 */

export type EntityKind = "path" | "lib" | "id" | "err" | "noun";

export interface ExtractedEntity {
  key: string;
  kind: EntityKind;
  surface: string;
  /** Anchor strength: structural=3, lib=2, noun=1. Feeds rarity*kindBoost edge weighting. */
  weight: number;
}

/** Canonical library/tool names (case-insensitive match → canonical surface).
 *  Must be a null-prototype object so that text tokens matching Object.prototype
 *  property names (e.g. "constructor") do not resolve to inherited non-string
 *  values and crash surface.toLowerCase() (see #extract-constructor-crash). */
const LEXICON: Record<string, string> = Object.create(null) as Record<string, string>;
for (const name of [
  "jose", "jsonwebtoken", "pnpm", "npm", "yarn", "sqlite", "better-sqlite3", "vite", "postgres",
  "postgresql", "pgvector", "sqlite-vec", "drizzle", "turbo", "turborepo", "eslint", "prettier",
  "hono", "stripe", "fts5", "redis", "playwright", "vitest", "zod", "react", "nextjs", "node",
  "typescript", "argon2id", "bullmq", "pino", "sentry", "s3", "grafana", "opentelemetry", "codecov",
  "postmark", "keycloak", "minilm", "onnx", "next-intl",
]) {
  LEXICON[name.toLowerCase()] = name;
}

/** English function words + code-chatter that must never become entities. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "of", "to", "in", "on", "at",
  "by", "with", "from", "into", "out", "up", "down", "over", "under", "is", "are", "was", "were",
  "be", "been", "being", "do", "does", "did", "done", "have", "has", "had", "will", "would", "can",
  "could", "should", "may", "might", "must", "not", "no", "yes", "this", "that", "these", "those",
  "it", "its", "they", "them", "their", "we", "our", "you", "your", "i", "my", "as", "so", "than",
  "too", "very", "just", "only", "also", "how", "what", "when", "where", "why", "which", "who",
  // code chatter
  "file", "files", "change", "changes", "update", "updates", "value", "values", "run", "runs",
  "fix", "fixes", "use", "uses", "used", "using", "set", "sets", "get", "gets", "add", "adds",
  "need", "needs", "make", "makes", "via", "per", "etc", "new", "old", "one", "two", "three",
  "first", "last", "next", "now", "still", "back", "way", "thing", "things", "note", "code",
  "server", "client", "tier", "default", "config", "based", "instead", "across", "between",
  // quantifiers / determiners / adverbs / prepositions that are never entities
  "every", "each", "any", "all", "some", "more", "most", "less", "other", "another", "such",
  "same", "both", "many", "much", "own", "into", "onto", "within", "around", "here", "there",
  "again", "once", "while", "before", "after", "during", "per", "off", "out", "above", "below",
  "every", "without", "upon",
  // TWO-LETTER ENGLISH, previously hidden by the three-character floor (Codex review, PR #189).
  // Removing that floor removed the implicit filtering it was doing, and this list is where the
  // explicit filtering belongs — the floor was never the right home for English vocabulary. Found
  // by measuring AFTER the floor came down: an earlier check ran while it was still 3, so it could
  // not tell "already in STOPWORDS" from "dropped by the floor" and reported a clean result.
  "he", "me", "us", "am", "go", "id", "ok", "vs", "re", "ye", "oh", "ah", "eh", "hi", "ha",
  "na", "um", "er", "uh", "hm", "ya", "yo", "pm", "ie", "eg",
  // Non-Latin function words. Single-character ones (的, 를, の) never reach here — `tooShort`
  // drops them — so this covers only the two-character forms that would otherwise pass the dense-
  // script floor and become entities. A STARTING set from the scripts #187 was reported against,
  // not a complete one for any of them; extend per script as real text arrives.
  "した", "する", "ある", "いる", "この", "その", "など", "ため", "よう", "もの", "こと",
  "から", "まで", "より", "および", "ます", "です",
  "하는", "있는", "없는", "이런", "그런", "대해", "통해", "위해", "때문", "그리고", "하지만",
  "这个", "那个", "可以", "因为", "所以", "但是", "如果", "已经", "还有", "以及",
]);

const PATH_FILE = /\b[\w./-]*\w[\w-]*\.(?:ts|tsx|js|jsx|mjs|cjs|json|sql|md|sh|ya?ml|py|go|rs|toml|css)\b/g;
const PATH_SLASH = /\b\w[\w-]*(?:\/[\w.-]+)+\b/g;
const CAMEL = /\b[A-Za-z][a-z0-9]*[A-Z]\w*\b/g; // camelCase AND PascalCase (internal capital required)
const SNAKE = /\b[a-z0-9]+_[a-z0-9_]+\b/g;
const DOTTED = /\b[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w+)+\b/g;
const ERRCODE = /\b(?:E[A-Z]{3,}|[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+|E\d{2,})\b/g;
/** Latin-only, and deliberately so: it scans for LEXICON hits, and every lexicon entry is an ASCII
 *  package name. The noun pass uses `words()` below instead. */
const WORD = /[a-z][a-z0-9]*/g;

/**
 * Word segmentation for every script, via ICU. `WORD` recognized `[a-z]` only, so all non-Latin
 * text produced ZERO entities and therefore zero derived edges (#187) — Korean, Cyrillic, Greek,
 * Arabic and Hebrew because of the character class, and Chinese/Japanese/Thai additionally because
 * they are not whitespace-delimited at all, which no character class can solve.
 *
 * Still dependency-free: Intl.Segmenter is part of the runtime (Node 22 ships full ICU). It is NOT
 * as version-stable as a regex, though — a future ICU revision can segment a given string
 * differently, so extraction is deterministic for a given runtime rather than across all of them.
 * That is a real weakening of this module's original promise, accepted because the alternative it
 * replaces was not "less deterministic", it was "silently empty for most of the world's text".
 * Edges are re-derived rather than frozen, so the effect of a shift is drift, not corruption.
 */
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "word" });

function words(text: string): string[] {
  const out: string[] = [];
  for (const s of SEGMENTER.segment(text)) if (s.isWordLike) out.push(s.segment);
  return out;
}

/**
 * TWO CHARACTERS, IN EVERY SCRIPT. There is no script test here, and that is the fix.
 *
 * The old floor was three, which exists to drop English function words. Two attempts to keep it
 * conditional both failed the same way (Codex review, PR #189): first a list of four scripts, which
 * read as "every script" while still discarding Hebrew שם, Hindi की and Greek γη; then
 * `\p{Script=Latin}`, which is not English either and discarded French os, German Ei, Vietnamese cá.
 *
 * The thing that is actually English-specific is the WORD LIST, not a property of the script — and
 * STOPWORDS already is that list. Verified before making the change: every two-letter English
 * function word ("of", "to", "is", "it", "as", "so", "up", "an", "no", "do", …) is already in it, so
 * lowering the floor leaks none of them. A predicate that does not exist cannot have a third
 * counterexample.
 */
function tooShort(token: string): boolean {
  return token.length < 2;
}

/** Any script's letters. Numbers alone are not entities — see the noun pass for why. */
const HAS_LETTER = /\p{L}/u;

export function extractEntities(text: string): ExtractedEntity[] {
  const out = new Map<string, ExtractedEntity>();
  const add = (kind: EntityKind, surface: string, weight: number): void => {
    const key = `${kind}:${kind === "noun" || kind === "lib" ? surface.toLowerCase() : surface}`;
    if (!out.has(key)) out.set(key, { key, kind, surface, weight });
  };

  let residual = text;
  const strip = (re: RegExp, kind: EntityKind, weight: number): void => {
    residual = residual.replace(re, (m) => {
      add(kind, m, weight);
      return " ".repeat(m.length); // keep offsets stable; remove from noun pass
    });
  };

  // Pass 1 — structural (order matters: paths before dotted so foo.ts isn't a dotted id).
  strip(PATH_FILE, "path", 3);
  strip(PATH_SLASH, "path", 3);
  strip(ERRCODE, "err", 3);
  strip(CAMEL, "id", 3);
  strip(SNAKE, "id", 3);
  strip(DOTTED, "id", 3);

  // Lexicon libs (scan the original lowercased text; canonical surface).
  const lower = text.toLowerCase();
  for (const token of lower.match(WORD) ?? []) {
    if (LEXICON[token]) add("lib", LEXICON[token], 2);
  }

  // Pass 2 — plain nouns from what's left. NFC before anything else (Codex review, PR #189): an
  // entity key IS the join column for `about` edges, so a composed and a decomposed spelling of the
  // same word — routine across input methods and operating systems — would otherwise be two keys
  // and two concepts mentioning it would never link.
  for (const segment of words(residual.toLowerCase().normalize("NFC"))) {
    // SPLIT ON EVERYTHING THAT IS NOT A LETTER, DIGIT OR MARK — which is what the old
    // `[a-z][a-z0-9]*` did by construction, since it could only ever match runs of those.
    //
    // ICU keeps punctuation-bearing strings together as one word, so both of these leaked into noun
    // morphology (Codex review, PR #189): "it's" was not in STOPWORDS and singularize took its
    // trailing s, emitting `noun:it'`; and a filename with a non-Latin basename never matched the
    // ASCII-only structural patterns, so "café.ts" became `noun:café.t` — an entity that also failed
    // to share a key with a plain mention of café. One split fixes both, where an apostrophe-only
    // split fixed the first and left the second.
    for (const token of segment.split(/[^\p{L}\p{N}\p{M}]+/u)) {
      // A SEGMENT MUST CONTAIN A LETTER (Codex review, PR #189). `isWordLike` is true for numbers,
      // so "2026" and "3.14" became entities; the old `[a-z][a-z0-9]*` required a leading letter,
      // and this module's contract has always been to drop numeric tokens. Dates, counts and
      // version numbers are exactly the tokens that would otherwise link unrelated concepts.
      if (!HAS_LETTER.test(token)) continue;
      if (tooShort(token) || STOPWORDS.has(token) || KOREAN_PARTICLE_SET.has(token) || LEXICON[token]) continue;
      add("noun", normalizeToken(token), 1);
    }
  }

  return [...out.values()];
}

/**
 * Per-script morphology. This module always did language-specific normalization — `singularize` is
 * English plural stripping and STOPWORDS is an English function-word list. The defect was never
 * that it is language-specific; it is that only ONE language was ever added. This dispatch makes
 * that structural, so the next script is an entry rather than a rewrite.
 */
function normalizeToken(w: string): string {
  return HANGUL_ONLY.test(w) ? stripKoreanParticle(w) : singularize(w);
}

const HANGUL_ONLY = /^\p{Script=Hangul}+$/u;

/**
 * Korean 조사 (particles) are a CLOSED class, which is what makes stripping them the same move
 * `singularize` makes for English plurals rather than a guess. Without it 주식/주식을/주식이/주식은
 * are four different entities and no two concepts mentioning the stock tracker ever link — which
 * is the entire point of extracting entities.
 *
 * Longest match wins, and a strip never leaves fewer than two syllables: 마을 and 가을 end in 을
 * without containing a particle, and the length guard is what saves them. It is not perfect — 물리학과
 * loses its 과 — and that is the same class of error `singularize` accepts for English, bounded the
 * same way, by a guard rather than by a dictionary.
 */
const KOREAN_PARTICLES = [
  "으로서", "으로써", "에게서", "에서는", "이라고", "라고", "으로", "에서", "에게", "한테",
  "부터", "까지", "보다", "처럼", "마다", "조차", "이나", "라는", "이란", "에는",
  "은", "는", "이", "가", "을", "를", "에", "의", "와", "과", "도", "만", "랑",
];

/** A token that is ENTIRELY a particle is always a particle — Korean spacing puts one on its own
 *  often enough that this leaks otherwise ("에서" surviving as a noun). The strip below cannot
 *  catch it: its two-syllable floor refuses to reduce a token to nothing, which is correct there
 *  and wrong here, so this is a separate check rather than a loosened guard. */
const KOREAN_PARTICLE_SET = new Set(KOREAN_PARTICLES);

function stripKoreanParticle(w: string): string {
  for (const p of KOREAN_PARTICLES) {
    if (w.endsWith(p) && w.length - p.length >= 2) return w.slice(0, -p.length);
  }
  return w;
}

/** Conservative deterministic singularizer (never touches structural entities). */
export function singularize(w: string): string {
  if (w.length <= 3) return w;
  if (/(us|is|os|as|ss)$/.test(w)) return w; // status/analysis/class — not plurals
  if (w.endsWith("ies")) return w.slice(0, -3) + "y"; // policies → policy
  if (/(sses|shes|ches|xes|zes)$/.test(w)) return w.slice(0, -2); // boxes → box
  if (w.endsWith("s")) return w.slice(0, -1); // tokens → token
  return w;
}
