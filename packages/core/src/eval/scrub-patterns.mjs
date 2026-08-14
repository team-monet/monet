/**
 * scrub-patterns.mjs — SINGLE SOURCE OF TRUTH for the Phase 1 corpus pipeline's content-pattern
 * scrubbing (`scrubString`), shared between scripts/scrub-corpus.mjs (scrubs md/json file CONTENT)
 * and src/eval/md-export-store.ts (round-2 fix, P1-b: scrubs a concept TITLE before deriving a
 * topic-file slug from it — see that module's call site for why).
 *
 * WHY THIS MOVED OUT OF scrub-corpus.mjs (round 2 review fix, P1-b): the finding is "topic
 * FILENAMES (topics/<slug>.md) derive from concept titles and can embed sensitive strings —
 * scrubbing file CONTENTS doesn't touch file NAMES." The two sanctioned fixes were (a) scrub
 * titles before slug derivation in the export stage, or (b) a slug-sanitize rename-map pass in
 * scrub. (b) was tried first and found INSUFFICIENT by construction: slugify() (md-export.ts)
 * lowercases and collapses EVERY non-alphanumeric run — slashes, dots, tildes, `@`, colons, spaces,
 * everything — into a single hyphen before truncating to 48 chars. That destroys the exact
 * structural signal every scrubString pattern depends on (a leading `/Users/`, a leading `~/`, an
 * `@` in an email, dots in an IP octet run) — verified empirically:
 *   slugify("~/.monet/monet.db")                      → "monet-monet-db"       (no residual tell)
 *   slugify("contact jane.doe@example.com about this") → "contact-jane-doe-example-com-about-this" (no residual tell)
 *   slugify("build plan ... /Users/dev/code/...")  → "...-users-dev-..." (residual "users" — but only by luck, because "Users" happens to survive as a literal word)
 *   slugify("...http://192.168.1.10:9301...")          → "...-http-192-1"        (residual "http"/digits — same luck)
 * A rename-map pass that re-runs scrubString against an ALREADY-SLUGIFIED string can only ever
 * catch the last two cases (where a distinctive keyword happens to survive hyphenation) — it is
 * structurally blind to the tilde-path and email cases, which slugify to indistinguishable-from-
 * ordinary-prose hyphen runs with no residual signal at all. That is a real, not cosmetic,
 * correctness gap, so route (a) — scrub the TITLE before slugify() ever runs, while the original
 * separators (/, ~, @, .) are still intact and every existing pattern still matches normally — is
 * the one actually implemented. This module is what makes (a) possible without inverting this
 * pipeline's established import direction (scripts/ imports FROM src/eval/, never the reverse):
 * moving scrubString here, rather than importing it INTO src/eval/md-export-store.ts FROM
 * scripts/scrub-corpus.mjs, keeps that direction intact. scrub-corpus.mjs now imports its
 * `scrubString` from here too — a single definition, not two independently-maintained copies.
 *
 * WHY A PLAIN .mjs FILE (not .ts), same reasoning as corpus-scope.mjs's own module doc: this must
 * be importable both from `tsx`-run TypeScript (src/eval/md-export-store.ts) and from
 * plain-`node`-invoked scrub-corpus.mjs, with zero build step and zero drift risk between a "real"
 * .ts definition and a hand-copied .mjs mirror. A sibling scrub-patterns.d.mts gives the .ts
 * consumer real types instead of an implicit `any`.
 */

// ── Pattern scrubbers ──────────────────────────────────────────────────────────────────────

export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Prefix-specific minimum trailing length, chosen empirically against the real corpus this
// pipeline scrubs: short enough to catch real key shapes, long enough that ordinary hyphenated
// English words sharing a prefix (sk-based, sk-file, sk-author, sk-index — all real
// false-positive hits found while designing this pattern against actual exported content) never
// match.
export const SECRET_RE =
  /\b(sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._-]{20,})\b/g;

// F3 fix (post-review): SECRET_RE above is a fixed known-vendor-prefix list — it missed a real,
// differently-shaped key (`key_GZTqlLr41FS2p7AY`, a Constructor.io public read-only key) that
// survived scrubbing into committed artifacts (eval-corpus/publish/full/chunks.json, verified
// empirically). Two additional, narrower patterns close this specific gap without loosening the
// existing false-positive guard (the sk-author/sk-fixture class must still survive — these two
// patterns are additive, SECRET_RE's own alternation and length floors are untouched):
//
//   QUERY_PARAM_SECRET_RE — a `?key=`/`&api_key=`/`&token=`/`&secret=`/`&auth=`-style query
//   param whose value is long enough (12+ chars) to be a real credential rather than a short
//   placeholder/example value. Case-insensitive on the param NAME (an env-style `?API_KEY=` or
//   `?Token=` should redact the same as `?key=`) — verified empirically against the full real
//   corpus that this introduces zero false positives (no other key/token/secret/auth-named query
//   param appears anywhere in the 323-concept source store).
//   BARE_KEY_RE — a bare `key_<alnum>{10,}` token (the shape of the Constructor.io leak itself,
//   independent of whether it appears inside a query string) — same empirical zero-false-positive
//   check against the full corpus (no other `key_...` token of this length exists in the store).
//
// Both were validated against the FULL 323-concept source corpus (not just the one known-bad
// concept) before being added, per this module's existing "chosen empirically against THIS
// corpus" methodology for SECRET_RE above.
export const QUERY_PARAM_SECRET_RE = /([?&](?:key|api_key|apikey|token|secret|auth)=)([A-Za-z0-9_-]{12,})/gi;
export const BARE_KEY_RE = /\bkey_[A-Za-z0-9]{10,}\b/g;

// Repo directories whose paths are the PROOF'S OWN source — fine to reference in a proof repo
// about them. Deliberately NOT ".monet" (the live DATA STORE location, e.g. ~/.monet/monet.db —
// that is personal-account data-path leakage exactly like any other /Users/ path and must be
// redacted, not allowlisted, even though the name contains "monet").
export const MONET_REPO_DIRS = ["monet-core", "monet-site", "example-benchmark"];

/** True when `p` (an absolute /Users/... path) is a code path inside one of the proof's own repos. */
function isProofRepoPath(p) {
  return MONET_REPO_DIRS.some((dir) => p.includes(`/${dir}/`) || p.endsWith(`/${dir}`));
}

// Matches a /Users/<name>/... run of path segments (stops at whitespace, backtick, quote, paren,
// or another path-illegal char — the same "what ends a path token in prose" boundary a human
// reading a sentence would use).
export const USERS_PATH_RE = /\/Users\/[^\s`'")\]]+/g;

// P1-a fix (round 2): the tilde-form home path. Same token-boundary discipline as USERS_PATH_RE
// for the END of the match (stop at whitespace/backtick/quote/paren/bracket) — but, unlike an
// earlier version of this pattern, deliberately has NO start-of-token lookbehind. A literal `~/`
// (tilde immediately followed by a slash) is already a highly specific 2-character anchor with no
// legitimate false-positive shape in ordinary English prose (verified empirically against the
// real source corpus: every `~/`-containing concept in eval-corpus/source/monet.db is a genuine
// home-directory path reference — `~/code`, `~/.monet`, etc. — never e.g. an approximation symbol
// beside a slash). A start-boundary lookbehind was tried first and found to be an actual bug: it
// required the tilde to be preceded by whitespace or an OPENING bracket char, so a tilde path
// immediately after a backtick or double-quote (e.g. `` `~/.monet/monet.db` ``, `"~/.monet/monet.db"`
// — both realistic markdown/prose quoting styles) was silently skipped, since backtick/quote
// weren't in that allowed-preceding-char set. Removing the lookbehind entirely (matching
// USERS_PATH_RE's own approach, which has no start-boundary condition at all) fixes that and is
// simpler.
//
// SECOND bug found regenerating against the real corpus (the trailing char class was `+`, one-or-
// more): two REAL concept TITLES in the source store are themselves truncated (by the engine's
// own title-derivation logic, upstream of and unrelated to this pipeline) at the exact point a
// body's first-line/sentence extraction landed mid-path — e.g. a title literally ending
// "...operating on the live ~/" with NOTHING after the trailing slash (the rest of the real path,
// ".monet/monet.db", never made it into the truncated title field at all). A `+` (require at
// least one char after `~/`) does not match that bare trailing `~/`, so it survived scrubbing —
// verified empirically: `grep -rn '~/' eval-corpus/publish/` still hit 8 files after the P1-a fix
// otherwise worked (bodies containing a full `~/.monet/monet.db` were correctly redacted; the
// unredacted survivors were exclusively these two truncated-title instances, both TITLE fields
// specifically). Fixed by changing the quantifier to `*` (zero-or-more) — a bare `~/` immediately
// followed by whitespace/end-of-string/a boundary char still redacts (correctly recognizing "this
// references a home directory" even truncated), while a full path after it is still captured
// completely exactly as before (the `*` only changes behavior when there is NOTHING to capture,
// which `+` refused to match at all).
export const TILDE_PATH_RE = /~\/[^\s`'")\]]*/g;

// P1-c fix (round 2): RFC1918 private-address ranges — 10.0.0.0/8, 172.16.0.0/12 (172.16.x through
// 172.31.x only, NOT the full 172.x range), 192.168.0.0/16 — each optionally followed by a `:port`
// and/or a `/path` run, with an optional `http(s)://` scheme prefix folded into the same match so
// the whole sensitive endpoint (scheme+host+port+path) is replaced by one opaque token rather than
// leaving the scheme or a bare trailing path fragment behind. Path/port character class mirrors
// USERS_PATH_RE/TILDE_PATH_RE's own path-token boundary (stop at whitespace/backtick/quote/paren).
// Also captures an OPTIONAL immediately-following ", tenant <name>" clause as a combined match —
// see the full history/rationale directly below this pattern's definition.
//
// P1-c fix (round 2): a tenant identifier immediately, SYNTACTICALLY associated with a private
// endpoint — e.g. "http://192.168.1.10:9301, tenant acme". This is now folded into
// PRIVATE_ENDPOINT_RE ITSELF as one combined match (see below) rather than a separate pattern,
// after two earlier designs were tried and found unsafe. History, for the next person who touches
// this (both failure modes were caught empirically against the FULL real corpus, not assumed):
//
//   ATTEMPT 1 — a bare `\btenant\s+([A-Za-z][A-Za-z0-9-]*)\b` pattern, applied unconditionally.
//   REJECTED: a direct query of every real "tenant <word>" occurrence in
//   eval-corpus/source/monet.db turned up 16 matches; only ONE ("tenant acme") is an actual
//   tenant identifier. The other 15 — "tenant wall", "tenant schema", "tenant isolation", "tenant
//   Postgres", "tenant scoping", "tenant plane", "tenant model", "tenant framing", "tenant
//   boundary", "tenant audit", "tenant assignment", "tenant DDL", "Tenant MCP", "TENANT vs",
//   "TENANT ROUTING" — are ordinary architecture-documentation nouns used as compound-noun
//   modifiers after "tenant" (multi-tenancy design prose is common in this corpus). There is NO
//   reliable lexical/orthographic signal distinguishing "tenant acme" from "tenant DDL" — both are
//   bare identifier-shaped words immediately following "tenant". This unconditional pattern
//   corrupted real documentation ("ensureTenantSchemasCurrent reviews tenant DDL, with backfill
//   needed" became "...reviews tenant [redacted-tenant], with backfill...").
//
//   ATTEMPT 2 — gate the bare pattern on "does the SAME STRING (as passed to scrubString) also
//   contain a PRIVATE_ENDPOINT_RE match anywhere", plus a same-string co-reference pass that
//   additionally redacted every OTHER bare occurrence of a discovered tenant name elsewhere in
//   that string (to also catch a second, back-referencing mention like "the acme endpoint" with
//   no literal word "tenant" nearby). REJECTED, for a DIFFERENT reason than attempt 1: scrubString
//   is called once per FILE (index.md, a topic file, chunks.json), and index.md in particular
//   aggregates ALL concepts' one-line summaries into ONE string — so "the same string contains an
//   endpoint somewhere" is true for the WHOLE index.md file the moment ANY one concept (example-host)
//   has a private endpoint, even though a COMPLETELY UNRELATED concept's "tenant DDL" sentence
//   sits ~39,750 characters away in the same file. Verified empirically: this attempt corrupted
//   the exact same "reviews tenant DDL" sentence attempt 1 did, via index.md specifically (the
//   per-concept topic file for that sentence was correctly clean; only the aggregated index.md
//   file, which also happens to contain example-host's endpoint elsewhere, was corrupted). A
//   paragraph-level or fixed-character-window proximity check was considered as a middle ground
//   and also rejected: measured the real leak's OWN two mentions are 1019 characters and 4
//   paragraph-breaks apart (the "tenant acme" definition and the later "the acme endpoint"
//   back-reference are in different paragraphs of the SAME concept) — no window size threads the
//   needle between "wide enough to span the real leak's own two mentions" and "narrow enough to
//   never span into a different, unrelated concept in a large aggregated file", because the
//   real-positive and false-positive distances overlap (19 chars for the closest real mention, up
//   to ~40,000 chars for a same-file false positive — a window that includes the former also risks
//   including many false positives in a densely-packed cluster file).
//
// FIX (this version) — make the syntactic association PART OF PRIVATE_ENDPOINT_RE'S OWN MATCH,
// not a separate cross-string check: an optional `, tenant <name>` clause is captured as a trailing
// component of the SAME regex match that already anchors on the endpoint itself. This is provably
// local (a single regex match span can never straddle two unrelated concepts merged into one large
// file — the match either includes the immediately-following ", tenant <name>" text or it doesn't,
// with nothing else in the file able to influence that) and requires no whole-string/whole-file
// gate at all. Verified against both real cases: matches "http://192.168.1.10:9301, tenant acme"
// as ONE span in the real leak; does NOT match "tenant DDL" anywhere (there is no private endpoint
// immediately before it) in the false-positive case.
//
// ACCEPTED, DOCUMENTED LIMITATION: this fix closes the tenant name's POINT OF DEFINITION (its
// first, endpoint-adjacent mention) but does NOT catch a later bare back-reference to the same
// name elsewhere in the document with no endpoint nearby (e.g. "the acme endpoint", ~1000
// characters after the definition, in the real leak's own text) — the co-reference mechanism that
// would have caught this (attempt 2 above) is exactly what was proven unsafe against large
// aggregated files. This is a real, accepted trade: a narrower, un-gameable, definitely-safe fix
// over a broader one that corrupts real documentation. Flagged explicitly rather than silently
// left uncaught — see this module's own test suite for a test asserting this residual gap exists.
//
// COMMA-CONSUMPTION BUG, found via adversarial testing (not the real corpus this time — an
// engineered case): the path-matching group `(?:\/[^\s...]*)?` originally allowed `,` inside a
// matched path (only whitespace/backtick/quote/paren/bracket ended it), so an endpoint WITH a
// trailing path immediately followed by a tenant clause — e.g.
// "http://192.168.1.1:8080/path, tenant first" — had its path group greedily consume the comma
// too, leaving nothing for the `(?:,\s*tenant\s+...)?` group to anchor on; "tenant first" then
// survived as unredacted literal text. The real leak's own phrasing has NO trailing path before
// its tenant clause (verified: `http://192.168.1.10:9301, tenant acme`, port but no path), so this
// specific combination doesn't happen to occur in the actual corpus — but the fix must not depend
// on that being true forever. Added `,` to the path group's excluded-character class (alongside
// the existing whitespace/backtick/quote/paren/bracket set) — a real URL path containing a literal
// unencoded comma is not a realistic shape this pipeline needs to preserve, and doing so removes
// the greediness conflict entirely rather than relying on this exact corpus never exercising it.
//
// NEWLINE-ADJACENCY BUG, found by an independent adversarial review pass (verified, not just
// taken on claim — reproduced directly): the tenant-clause group used `\s*`/`\s+` around "tenant",
// and `\s` matches a literal newline — so an endpoint at the end of one line, followed by a bare
// trailing comma, with an UNRELATED "tenant <word>" phrase merely happening to start the very NEXT
// line, was treated as one syntactically-adjacent match (e.g. "...at 10.9.9.9,\ntenant unrelated
// appears..." incorrectly redacted "unrelated" as a tenant name). This is a milder recurrence of
// the exact "spurious adjacency across unrelated content" failure mode attempt 2 was rejected for
// — the whole point of requiring true syntactic adjacency is defeated if "adjacency" is allowed to
// span a line break, since a line break is exactly the kind of structural boundary that separates
// unrelated content in this pipeline's own markdown output (a new bullet, a new paragraph, a new
// concept's heading). Fixed by replacing `\s` with `[^\S\n]` (whitespace that is NOT a newline) in
// both whitespace positions of the tenant-clause group — same-line adjacency is still matched
// exactly as before (verified: the real leak's actual single-space-after-comma phrasing is
// unaffected), but a tenant-word merely starting the next line no longer attaches to a prior line's
// endpoint match.
export const PRIVATE_ENDPOINT_RE =
  /\b(?:https?:\/\/)?(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})(?::\d{1,5})?(?:\/[^\s`'"),\]]*)?(?:,[^\S\n]*tenant[^\S\n]+([A-Za-z][A-Za-z0-9-]*))?/gi;

function scrubPathToken(match) {
  if (isProofRepoPath(match)) {
    // Generalize rather than redact: keep only from the repo dir name onward, so
    // "/Users/dev/code/monet-core/src/engine.ts" → "monet-core/src/engine.ts". This is not a
    // privacy leak (referencing the proof's own repo layout in the proof's own corpus is fine)
    // and is MORE useful to a reader than a blanket redaction would be.
    for (const dir of MONET_REPO_DIRS) {
      const idx = match.indexOf(`/${dir}`);
      if (idx !== -1) return match.slice(idx + 1); // drop the leading slash too
    }
  }
  return "[redacted-path]";
}

/**
 * Scrub every recognized sensitive pattern out of a single string. Applied to every string value
 * found in md files / chunks.json / corpus.json (scrub-corpus.mjs), AND to a concept title before
 * that title is slugified into a topic-file name (md-export-store.ts, P1-b fix) — the same
 * function, so a new pattern added here automatically protects both file CONTENT and file NAMES
 * with no separate list to keep in sync.
 */
export function scrubString(s) {
  if (typeof s !== "string") return s;
  let out = s.replace(EMAIL_RE, "[redacted-email]");
  out = out.replace(SECRET_RE, "[redacted-secret]");
  // F3 fix: query-param values keep the `?key=`/`&token=`/... prefix (capture group 1) so the
  // redaction reads as "there was a credential here", not just a bare token with context erased —
  // only the value (capture group 2, the actual secret material) is replaced.
  out = out.replace(QUERY_PARAM_SECRET_RE, (_m, prefix) => `${prefix}[redacted-secret]`);
  out = out.replace(BARE_KEY_RE, "[redacted-secret]");
  // P1-c fix: private endpoints (optionally with an immediately-following ", tenant <name>"
  // clause — see PRIVATE_ENDPOINT_RE's own doc comment for the full design history) before the
  // path scrubbers below — an endpoint like "http://192.168.1.10:9301" contains no "/Users/" or
  // "~/" run, so ordering against USERS_PATH_RE/TILDE_PATH_RE doesn't matter for correctness, but
  // scrubbing the more specific/sensitive network-address pattern first keeps the intent reading
  // top-to-bottom from "most specific credential-shaped thing" to "generic path". A capture-group
  // replacer is used (not a plain string) so the tenant-name capture group, when present, is
  // reflected in a DIFFERENT placeholder than when it's absent — this keeps "[redacted-private-
  // endpoint]" meaning "just an endpoint" and never silently implies a tenant name was also
  // present when it wasn't.
  out = out.replace(PRIVATE_ENDPOINT_RE, (_m, tenantName) =>
    tenantName ? `[redacted-private-endpoint], tenant [redacted-tenant]` : "[redacted-private-endpoint]",
  );
  out = out.replace(USERS_PATH_RE, scrubPathToken);
  // P1-a fix: tilde-form home paths — always fully redacted (see module doc: no proof-repo
  // generalization case applies to a `~/...` path the way it does for `/Users/.../monet-core`).
  out = out.replace(TILDE_PATH_RE, "[redacted-path]");
  return out;
}

/** Recursively scrub every string value in an arbitrary JSON-shaped value. */
export function scrubJson(val) {
  if (Array.isArray(val)) return val.map(scrubJson);
  if (val !== null && typeof val === "object") {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = scrubJson(v);
    return out;
  }
  if (typeof val === "string") return scrubString(val);
  return val;
}

/**
 * scrubString's SLUG-SAFE sibling, used ONLY by scrub-corpus.mjs's filename-rename safety net
 * (scrubFilenameIfNeeded/planFilenameRenames) — never for content scrubbing, which always uses the
 * full scrubString above.
 *
 * WHY THIS EXISTS (found empirically while testing the P1-b safety net, both-directions, per this
 * pipeline's own discipline): scrubString's SECRET_RE alternation has an existing false-positive
 * guard tuned against SPACE-separated prose — "sk-authored the design doc" does NOT match, because
 * SECRET_RE's `sk-[A-Za-z0-9_-]{10,}` character class stops at the space after "authored" (8
 * chars, under the 10-char floor). A slug is HYPHEN-joined, not space-joined, so the identical
 * phrase slugified — "sk-authored-design-notes" — DOES match: the character class
 * `[A-Za-z0-9_-]` includes hyphens, so it keeps consuming across what used to be word boundaries,
 * pushing the total length over the floor even though the underlying words are unrelated to any
 * real secret. Verified empirically against all 4 of scrubString's own documented false-positive
 * examples ("sk-authored the design doc", "sk-fixture data for the test", "sk-based approach to
 * caching", "sk-file naming convention") — every one becomes a false-positive match once
 * hyphenated into slug form. This is exactly the class of bug this pipeline's own testing
 * discipline ("extend the test suite for every new pattern, both directions") is meant to catch —
 * caught while writing tests for the safety net, not shipped.
 *
 * FIX: the slug-safe variant below omits ONLY SECRET_RE's vendor-prefix alternation (sk-/ghp_/
 * AKIA/xox/Bearer) — the one pattern with a CONFIRMED false-positive risk against slug text.
 *
 * HONEST ACCOUNTING of what the other patterns actually do against a REAL (already-slugified)
 * basename — checked directly, not assumed: EMAIL_RE, QUERY_PARAM_SECRET_RE, BARE_KEY_RE,
 * PRIVATE_ENDPOINT_RE (including its optional trailing tenant-clause capture), USERS_PATH_RE, and
 * TILDE_PATH_RE each require an anchor character (`@`, `?`/`&`/`=`, a literal `_`, an IP-octet dot
 * run, a literal `, tenant ` before the identifier, `/Users/`, `~/`) that slugify() has ALREADY
 * destroyed by the time a real basename reaches this function — so on GENUINE slug input, every
 * one of them is effectively INERT (verified: a slug simultaneously containing a would-be
 * private-endpoint octet run and a would-be tenant reference, e.g.
 * "...-http-192-1-tenant-acme.md", still returns null — neither the endpoint nor the tenant-clause
 * capture fires, since there's no dotted octet run or literal comma+space left to anchor on).
 * They are kept in scrubSlugSafe anyway for two reasons, not because they usefully fire on real
 * slugs today: (1) defense-in-depth against a FUTURE caller passing this function a
 * not-fully-slugified string (EMAIL_RE in particular DOES fire correctly if a literal "@" somehow
 * survives — covered by a real test), and (2) omitting them would be a needless divergence from
 * scrubString with no benefit, since they cost nothing and are harmless no-ops on real slug input.
 * The one EXCLUDED pattern (SECRET_RE) is excluded because it actively CAUSES false positives on
 * slugs, a fundamentally different reason than "provides no benefit."
 *
 * This does mean the safety net can no longer catch a still-hyphen-visible `sk-<key>` in slug form
 * (see scrub-corpus.test.ts's "documents the safety net's real, verified blind spot" tests) — an
 * intentional, documented trade: a narrow true-positive class this safety net was never the
 * PRIMARY mechanism for anyway (see md-export-store.ts, which scrubs the TITLE before slugify()
 * ever runs, while the real separator is still intact and SECRET_RE's prose-tuned guard behaves
 * correctly) traded for clearing 4 confirmed false positives on ordinary, legitimate slug text.
 */
export function scrubSlugSafe(s) {
  if (typeof s !== "string") return s;
  let out = s.replace(EMAIL_RE, "[redacted-email]");
  out = out.replace(QUERY_PARAM_SECRET_RE, (_m, prefix) => `${prefix}[redacted-secret]`);
  out = out.replace(BARE_KEY_RE, "[redacted-secret]");
  // Same combined endpoint+tenant pattern as scrubString above (see PRIVATE_ENDPOINT_RE's own doc
  // comment for the full design history) — in practice, the tenant-clause's `,\s*tenant\s+` anchor
  // means it is inert against genuinely-slugified input (slugify() replaces every comma/space with
  // a hyphen), but kept consistent with scrubString for the case where scrubSlugSafe is ever
  // called with a not-fully-slugified string.
  out = out.replace(PRIVATE_ENDPOINT_RE, (_m, tenantName) =>
    tenantName ? `[redacted-private-endpoint], tenant [redacted-tenant]` : "[redacted-private-endpoint]",
  );
  out = out.replace(USERS_PATH_RE, scrubPathToken);
  out = out.replace(TILDE_PATH_RE, "[redacted-path]");
  return out;
}
