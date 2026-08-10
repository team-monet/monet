/**
 * extract-entities.mjs — plain-.mjs MIRROR of src/extract-entities.ts's `extractEntities`, added
 * so scripts/scrub-db.mjs (invoked with plain `node`, not `tsx` — same portability requirement
 * documented in src/eval/corpus-scope.mjs's own module doc: "plain Node's ESM loader cannot
 * resolve an extensionless internal import inside a .ts file... without a TS-aware loader like
 * tsx") can call the exact same entity-extraction logic the engine uses at store time, without
 * introducing a TS-import dependency into a plain-node script.
 *
 * WHY THIS EXISTS (audit finding, round 2 — see scrub-db.mjs's own module doc, "ENTITY FRAGMENT
 * LEAK" section, for the full writeup): scrubbing entities.surface/entities.key with scrubString
 * closes the leak for entities whose surface text is ITSELF pattern-matchable (a full path, a
 * private endpoint). It does NOT close a narrower but real gap: the entity EXTRACTOR
 * (extractEntities) runs against RAW body/content text at store time and can split a sensitive
 * multi-token string into separate single-token entities BEFORE any scrub ever sees them — e.g.
 * "jane.doe@example.com" becomes two SEPARATE `id`-kind entities, `id:jane.doe` and
 * `id:example.com` (via the DOTTED regex below), neither of which individually contains an "@"
 * for EMAIL_RE to match, and "192.168.1.10:9301, tenant acme" contributes a bare `noun:acme`
 * entity with no adjacent IP octets for PRIVATE_ENDPOINT_RE to match. Verified directly against
 * the real corpus: `entities.surface = "gmail.com"` (kind=id) survives scrubEntities untouched
 * today, because "gmail.com" alone matches no scrub pattern — the sensitivity only existed in the
 * ORIGINAL combined string, which the extractor had already atomized before scrubEntities ever ran.
 *
 * THE FIX this module enables (implemented in scrub-db.mjs's pruneStaleEntities): re-run this
 * SAME extraction function against each concept's SCRUBBED text (scrubbed body + scrubbed
 * observation contents, joined — mirroring engine.ts's own rederiveConceptGraph text-assembly
 * convention) and compare the resulting entity-key set against what's still attached to that
 * concept in concept_entities. An entity key present before scrubbing but ABSENT from the
 * re-extraction against scrubbed text (e.g. `id:jane.doe`, `id:example.com`, `noun:acme` — because
 * the scrubbed text now reads "[redacted-email]" / "...tenant [redacted-tenant]...", which
 * extracts to harmless generic nouns like `noun:redacted`/`noun:email`/`noun:tenant` instead) is
 * PRUNED from that concept's membership; an `entities` row that ends up with zero remaining
 * members after pruning is deleted entirely. This is narrower and safer than re-deriving edges via
 * MonetCore.store() or engine.ts's own deriveEntityEdges (which also touches memory_edge/rarity/
 * hub-gating) — it ONLY prunes now-stale entity membership, never adds a new edge, never mutates
 * embeddings/support_count/dedup state.
 *
 * KEPT IN SYNC WITH src/extract-entities.ts: this file's extraction logic (LEXICON, STOPWORDS,
 * pattern order, key derivation) is a byte-for-byte mirror of that module's `extractEntities`. If
 * that module's extraction logic ever changes, this mirror must change identically — same
 * maintenance discipline this pipeline already accepts for src/eval/scrub-patterns.mjs (shared
 * between a .ts consumer and plain-node scripts) and src/eval/corpus-scope.mjs.
 */

const LEXICON = Object.create(null);
for (const name of [
  "jose", "jsonwebtoken", "pnpm", "npm", "yarn", "sqlite", "better-sqlite3", "vite", "postgres",
  "postgresql", "pgvector", "sqlite-vec", "drizzle", "turbo", "turborepo", "eslint", "prettier",
  "hono", "stripe", "fts5", "redis", "playwright", "vitest", "zod", "react", "nextjs", "node",
  "typescript", "argon2id", "bullmq", "pino", "sentry", "s3", "grafana", "opentelemetry", "codecov",
  "postmark", "keycloak", "minilm", "onnx", "next-intl",
]) {
  LEXICON[name.toLowerCase()] = name;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "of", "to", "in", "on", "at",
  "by", "with", "from", "into", "out", "up", "down", "over", "under", "is", "are", "was", "were",
  "be", "been", "being", "do", "does", "did", "done", "have", "has", "had", "will", "would", "can",
  "could", "should", "may", "might", "must", "not", "no", "yes", "this", "that", "these", "those",
  "it", "its", "they", "them", "their", "we", "our", "you", "your", "i", "my", "as", "so", "than",
  "too", "very", "just", "only", "also", "how", "what", "when", "where", "why", "which", "who",
  "file", "files", "change", "changes", "update", "updates", "value", "values", "run", "runs",
  "fix", "fixes", "use", "uses", "used", "using", "set", "sets", "get", "gets", "add", "adds",
  "need", "needs", "make", "makes", "via", "per", "etc", "new", "old", "one", "two", "three",
  "first", "last", "next", "now", "still", "back", "way", "thing", "things", "note", "code",
  "server", "client", "tier", "default", "config", "based", "instead", "across", "between",
  "every", "each", "any", "all", "some", "more", "most", "less", "other", "another", "such",
  "same", "both", "many", "much", "own", "into", "onto", "within", "around", "here", "there",
  "again", "once", "while", "before", "after", "during", "per", "off", "out", "above", "below",
  "every", "without", "upon",
  // Two-letter English, previously hidden by the three-character floor — see
  // src/extract-entities.ts for why this list is the right home for it.
  "he", "me", "us", "am", "go", "id", "ok", "vs", "re", "ye", "oh", "ah", "eh", "hi", "ha",
  "na", "um", "er", "uh", "hm", "ya", "yo", "pm", "ie", "eg",
  // Non-Latin function words — see src/extract-entities.ts for why only two-character forms.
  "した", "する", "ある", "いる", "この", "その", "など", "ため", "よう", "もの", "こと",
  "から", "まで", "より", "および", "ます", "です",
  "하는", "있는", "없는", "이런", "그런", "대해", "통해", "위해", "때문", "그리고", "하지만",
  "这个", "那个", "可以", "因为", "所以", "但是", "如果", "已经", "还有", "以及",
]);

const PATH_FILE = /\b[\w./-]*\w[\w-]*\.(?:ts|tsx|js|jsx|mjs|cjs|json|sql|md|sh|ya?ml|py|go|rs|toml|css)\b/g;
const PATH_SLASH = /\b\w[\w-]*(?:\/[\w.-]+)+\b/g;
const CAMEL = /\b[A-Za-z][a-z0-9]*[A-Z]\w*\b/g;
const SNAKE = /\b[a-z0-9]+_[a-z0-9_]+\b/g;
const DOTTED = /\b[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w+)+\b/g;
const ERRCODE = /\b(?:E[A-Z]{3,}|[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+|E\d{2,})\b/g;
const WORD = /[a-z][a-z0-9]*/g;

// ICU word segmentation — see src/extract-entities.ts for the full rationale (#187).
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "word" });

function words(text) {
  const out = [];
  for (const s of SEGMENTER.segment(text)) if (s.isWordLike) out.push(s.segment);
  return out;
}

// Two characters, every script — no script test. English-specific knowledge lives in STOPWORDS,
// which already holds every two-letter English function word. See src/extract-entities.ts.
function tooShort(token) {
  return token.length < 2;
}

const HAS_LETTER = /\p{L}/u;

const HANGUL_ONLY = /^\p{Script=Hangul}+$/u;

const KOREAN_PARTICLES = [
  "으로서", "으로써", "에게서", "에서는", "이라고", "라고", "으로", "에서", "에게", "한테",
  "부터", "까지", "보다", "처럼", "마다", "조차", "이나", "라는", "이란", "에는",
  "은", "는", "이", "가", "을", "를", "에", "의", "와", "과", "도", "만", "랑",
];

const KOREAN_PARTICLE_SET = new Set(KOREAN_PARTICLES);

function stripKoreanParticle(w) {
  for (const p of KOREAN_PARTICLES) {
    if (w.endsWith(p) && w.length - p.length >= 2) return w.slice(0, -p.length);
  }
  return w;
}

function normalizeToken(w) {
  return HANGUL_ONLY.test(w) ? stripKoreanParticle(w) : singularize(w);
}

export function extractEntities(text) {
  const out = new Map();
  const add = (kind, surface, weight) => {
    const key = `${kind}:${kind === "noun" || kind === "lib" ? surface.toLowerCase() : surface}`;
    if (!out.has(key)) out.set(key, { key, kind, surface, weight });
  };

  let residual = text;
  const strip = (re, kind, weight) => {
    residual = residual.replace(re, (m) => {
      add(kind, m, weight);
      return " ".repeat(m.length);
    });
  };

  strip(PATH_FILE, "path", 3);
  strip(PATH_SLASH, "path", 3);
  strip(ERRCODE, "err", 3);
  strip(CAMEL, "id", 3);
  strip(SNAKE, "id", 3);
  strip(DOTTED, "id", 3);

  const lower = text.toLowerCase();
  for (const token of lower.match(WORD) ?? []) {
    if (LEXICON[token]) add("lib", LEXICON[token], 2);
  }

  // NFC before filtering — see src/extract-entities.ts (Codex review, PR #189).
  for (const segment of words(residual.toLowerCase().normalize("NFC"))) {
    // Apostrophe split + letter requirement — see src/extract-entities.ts (Codex review, PR #189).
    for (const token of segment.split(/[^\p{L}\p{N}\p{M}]+/u)) {
      if (!HAS_LETTER.test(token)) continue;
      if (tooShort(token) || STOPWORDS.has(token) || KOREAN_PARTICLE_SET.has(token) || LEXICON[token]) continue;
      add("noun", normalizeToken(token), 1);
    }
  }

  return [...out.values()];
}

export function singularize(w) {
  if (w.length <= 3) return w;
  if (/(us|is|os|as|ss)$/.test(w)) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (/(sses|shes|ches|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}
