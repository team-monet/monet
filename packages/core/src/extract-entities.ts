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
]);

const PATH_FILE = /\b[\w./-]*\w[\w-]*\.(?:ts|tsx|js|jsx|mjs|cjs|json|sql|md|sh|ya?ml|py|go|rs|toml|css)\b/g;
const PATH_SLASH = /\b\w[\w-]*(?:\/[\w.-]+)+\b/g;
const CAMEL = /\b[A-Za-z][a-z0-9]*[A-Z]\w*\b/g; // camelCase AND PascalCase (internal capital required)
const SNAKE = /\b[a-z0-9]+_[a-z0-9_]+\b/g;
const DOTTED = /\b[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w+)+\b/g;
const ERRCODE = /\b(?:E[A-Z]{3,}|[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+|E\d{2,})\b/g;
const WORD = /[a-z][a-z0-9]*/g;

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

  // Pass 2 — plain nouns from what's left.
  for (const token of residual.toLowerCase().match(WORD) ?? []) {
    if (token.length < 3 || STOPWORDS.has(token) || LEXICON[token]) continue;
    add("noun", singularize(token), 1);
  }

  return [...out.values()];
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
