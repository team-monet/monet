/**
 * scrub-corpus.mjs unit tests — scrubString (F3 fix regression coverage; round-2 review fix
 * coverage for P1-a/P1-b/P1-c, the 3 P1 privacy leaks from this PR's Codex review).
 *
 * F3 (post-review, both reviews): SECRET_RE's fixed vendor-prefix list (sk-/ghp_/AKIA/xox/Bearer)
 * missed a real, differently-shaped key (`key_GZTqlLr41FS2p7AY`, a Constructor.io public key) that
 * survived scrubbing into committed artifacts (eval-corpus/publish/full/chunks.json — verified
 * empirically). Two additive patterns close this gap: a query-param heuristic
 * (`?key=`/`&api_key=`/`&token=`/`&secret=`/`&auth=`) and a bare `key_<alnum>{10,}` shape.
 *
 * BOTH DIRECTIONS are tested per the mission's explicit instruction:
 *   1. real secret-shaped strings (query-param and bare key_ forms) ARE redacted.
 *   2. the EXISTING false-positive guard still holds — ordinary English words sharing a prefix
 *      with a vendor pattern (sk-author, sk-fixture, etc., the class SECRET_RE was originally
 *      designed to exclude) must NOT be redacted, and the two NEW patterns must not introduce
 *      their own false positives on similarly-shaped ordinary text.
 *
 * Imports `scrubString` directly from the .mjs script (exported for testability; the script's
 * main() is guarded behind an import.meta.url entry-point check so importing it here never runs
 * the full pipeline as a side effect).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs script, no type declarations; imported for its exported pure scrub function only.
import { scrubString, scrubFilenameIfNeeded, assertDerivedDbExists } from "../../scripts/scrub-corpus.mjs";

describe("scrubString — F3 fix: query-param and bare key_ secret patterns", () => {
  describe("direction 1 — real secret-shaped strings ARE redacted", () => {
    it("redacts the exact real leak (Constructor.io key in a query string)", () => {
      const input =
        "GET https://ac.cnstrc.com/browse/items?key=key_GZTqlLr41FS2p7AY&ids=<P_id>&fmt_options[groups_max_depth]=0";
      const out = scrubString(input);
      expect(out).not.toContain("key_GZTqlLr41FS2p7AY");
      // Query-param prefix is preserved (context kept), only the value is redacted.
      expect(out).toContain("?key=[redacted-secret]");
    });

    it("redacts a bare key_ token even outside a query string", () => {
      const input = "The Constructor.io key is key_GZTqlLr41FS2p7AY and is passed as a header.";
      const out = scrubString(input);
      expect(out).not.toContain("key_GZTqlLr41FS2p7AY");
      expect(out).toContain("[redacted-secret]");
    });

    it("redacts other query-param secret shapes (api_key, token, secret, auth) case-insensitively on the param name", () => {
      const cases = [
        "?api_key=AbCdEf123456ghijkl",
        "&apikey=AbCdEf123456ghijkl",
        "&token=AbCdEf123456ghijkl",
        "&secret=AbCdEf123456ghijkl",
        "&auth=AbCdEf123456ghijkl",
        "?API_KEY=AbCdEf123456ghijkl", // env-style uppercase param name
        "&Token=AbCdEf123456ghijkl",
      ];
      for (const c of cases) {
        const out = scrubString(`see https://example.com/x${c}`);
        expect(out, `expected ${c} to be redacted`).toContain("[redacted-secret]");
        expect(out, `expected ${c}'s value to be gone`).not.toContain("AbCdEf123456ghijkl");
      }
    });

    it("does not redact a short query-param value (below the 12-char credential floor)", () => {
      // A short value is more likely a placeholder/example than a real credential — same
      // minimum-length philosophy SECRET_RE already applies to its vendor prefixes.
      const input = "?key=short1";
      const out = scrubString(input);
      expect(out).toBe(input);
    });
  });

  describe("direction 2 — existing + new false-positive guards still hold", () => {
    it("does NOT redact ordinary English words sharing the sk- prefix (the original guard class)", () => {
      const cases = ["sk-authored the design doc", "sk-fixture data for the test", "sk-based approach to caching", "sk-file naming convention"];
      for (const c of cases) {
        expect(scrubString(c), `expected "${c}" to survive unredacted`).toBe(c);
      }
    });

    it("does NOT redact an ordinary env-var NAME that merely contains 'KEY' with no '=' value attached", () => {
      const input = "Implemented in apps/web/lib/stock-health.ts with env ACME_STOCK_API_KEY as an optional fallback.";
      expect(scrubString(input)).toBe(input);
    });

    it("does NOT redact a bare 'key_' followed by too few characters to be a real credential", () => {
      const input = "the key_id field (short, not a secret)";
      expect(scrubString(input)).toBe(input);
    });

    it("does NOT redact a query param whose name merely contains but isn't exactly key/token/secret/auth", () => {
      // e.g. "primary_key=..." or "keyword=..." should not match — the pattern anchors on the
      // exact param-name alternatives, not a substring match, so it doesn't over-fire on unrelated
      // params that happen to contain one of these words.
      const input = "?primary_key=AbCdEf123456ghijkl&keyword=AbCdEf123456ghijkl";
      expect(scrubString(input)).toBe(input);
    });
  });
});

describe("scrubString — P1-a fix (round 2): tilde-form home paths", () => {
  describe("direction 1 — tilde paths ARE redacted", () => {
    it("redacts the exact real leak (~/.monet/monet.db, the live data-store path)", () => {
      const input = "Never read from the live store at ~/.monet/monet.db — always use a .backup'd copy.";
      const out = scrubString(input);
      expect(out).not.toContain("~/.monet/monet.db");
      expect(out).toContain("[redacted-path]");
    });

    it("redacts an arbitrary tilde-form path, not just the .monet example", () => {
      const input = "See the config at ~/code/some-project/config.json for details.";
      const out = scrubString(input);
      expect(out).not.toContain("~/code/some-project/config.json");
      expect(out).toContain("[redacted-path]");
    });

    it("redacts a tilde path even when it names one of the proof's own repo dirs (no allowlist for tilde form)", () => {
      // Unlike /Users/.../monet-core, which is generalized rather than redacted, a tilde path is
      // always a personal machine path — there's no legitimate "proof's own repo" reading of
      // "~/monet-core" the way there is for the absolute form, so this must be fully redacted.
      const input = "Cloned at ~/code/monet-core for local development.";
      const out = scrubString(input);
      expect(out).not.toContain("~/code/monet-core");
      expect(out).toContain("[redacted-path]");
    });

    it("stops the tilde-path match at whitespace/punctuation, same token-boundary discipline as /Users/", () => {
      const input = "(see ~/.monet/monet.db) and also `~/.monet/monet.db`, plus \"~/.monet/monet.db\".";
      const out = scrubString(input);
      expect(out).not.toContain(".monet/monet.db");
      // Trailing punctuation immediately after the path is preserved, not swallowed into the match.
      expect(out).toContain("[redacted-path])");
      expect(out).toContain("[redacted-path]`");
      expect(out).toContain('[redacted-path]"');
    });

    it("redacts a BARE trailing tilde-slash with nothing following it (a real title-truncation case found regenerating the actual corpus)", () => {
      // Found regenerating the real pipeline, not hypothetically: two real concept TITLES in the
      // source store are themselves truncated (by the engine's own upstream title-derivation
      // logic) at the exact point a body's first-line extraction landed mid-path — e.g. a title
      // literally ending "...operating on the live ~/" with NOTHING after the trailing slash. An
      // earlier version of TILDE_PATH_RE required at least one char after "~/" (a `+` quantifier)
      // and so did not match this bare trailing case at all — confirmed empirically via
      // `grep -rn '~/' eval-corpus/publish/` still hitting 8 files after the P1-a fix otherwise
      // worked correctly on every FULL path. Fixed via a `*` quantifier (zero-or-more).
      const truncatedTitle = "This concept holds three related facts about operating on the live ~/";
      const out = scrubString(truncatedTitle);
      expect(out).not.toContain("~/");
      expect(out).toContain("[redacted-path]");
      expect(out.endsWith("[redacted-path]")).toBe(true);
    });

    it("still fully captures a complete trailing path when one exists (the * quantifier fix does not regress the common case)", () => {
      const input = "config lives at ~/.monet/monet.db and nowhere else.";
      const out = scrubString(input);
      expect(out).not.toContain(".monet/monet.db");
      expect(out).toContain("config lives at [redacted-path] and nowhere else.");
    });
  });

  describe("direction 2 — existing /Users/ path behavior is unaffected", () => {
    it("still generalizes (not redacts) an absolute /Users/ path under a proof repo dir", () => {
      const input = "Implemented in /Users/dev/code/monet-core/src/engine.ts.";
      const out = scrubString(input);
      expect(out).toContain("monet-core/src/engine.ts");
      expect(out).not.toContain("/Users/dev");
    });

    it("still fully redacts an absolute /Users/ path NOT under a proof repo dir", () => {
      const input = "Personal note at /Users/dev/Documents/notes.txt.";
      const out = scrubString(input);
      expect(out).not.toContain("/Users/dev");
      expect(out).toContain("[redacted-path]");
    });

    it("does not double-match text that contains neither a tilde nor a /Users/ path", () => {
      const input = "This sentence has no home-directory path of any kind in it at all.";
      expect(scrubString(input)).toBe(input);
    });
  });
});

describe("scrubString — P1-c fix (round 2): private RFC1918 endpoints and syntactically-adjacent tenant names", () => {
  // DESIGN HISTORY (see PRIVATE_ENDPOINT_RE's own doc comment in scrub-patterns.mjs for the full
  // account): two earlier designs for tenant-name redaction were tried, both found unsafe against
  // the REAL corpus, and both are now gone. Attempt 1 (a bare "tenant <word>" pattern, unconditional)
  // corrupted 15 of 16 real "tenant <word>" occurrences in the source store (ordinary architecture
  // nouns like "tenant DDL"/"tenant model", not tenant identifiers). Attempt 2 (the same pattern,
  // gated on "does this whole STRING contain a private endpoint anywhere") was ALSO found unsafe —
  // NOT because of a false-positive-word problem this time, but a GRANULARITY problem: index.md
  // aggregates every concept's one-line summary into ONE string, so "contains an endpoint
  // somewhere" became true for the WHOLE FILE the instant any ONE concept (example-host) had a
  // private endpoint, corrupting a totally unrelated concept's "reviews tenant DDL" sentence
  // ~39,750 characters away in the same file. The tests below reflect the FINAL, corrected design:
  // the tenant clause is folded directly into PRIVATE_ENDPOINT_RE's own match as an optional
  // trailing capture group, requiring true syntactic adjacency (", tenant <name>" immediately
  // after the endpoint) rather than any cross-string/cross-file heuristic — a design that cannot
  // straddle two unrelated concepts no matter how large or how many concepts a file aggregates.
  describe("direction 1 — private endpoints (with or without an adjacent tenant clause) ARE redacted", () => {
    it("redacts the exact real leak (192.168.x host:port from example-host's remote endpoint, with its immediately-adjacent tenant clause)", () => {
      const input = "example-host (the remote/server Monet at http://192.168.1.10:9301, tenant acme) is PROD.";
      const out = scrubString(input);
      expect(out).not.toContain("192.168.1.10");
      expect(out).not.toContain("9301");
      expect(out).toContain("[redacted-private-endpoint]");
      expect(out).not.toMatch(/tenant\s+acme\b/);
      expect(out).toContain("tenant [redacted-tenant]");
    });

    it("redacts a bare 192.168.x.x address with no port or path", () => {
      const input = "Reachable at 192.168.1.42 on the local network.";
      expect(scrubString(input)).not.toContain("192.168.1.42");
    });

    it("redacts a 10.x.x.x address (RFC1918 class A range)", () => {
      const input = "Internal service at http://10.0.4.12:8080/health.";
      const out = scrubString(input);
      expect(out).not.toContain("10.0.4.12");
      expect(out).toContain("[redacted-private-endpoint]");
    });

    it("redacts a 172.16-31.x.x address (RFC1918 class B range) but not the wider 172.x range boundary", () => {
      const inRange = scrubString("Service at 172.20.5.9:3000/api");
      expect(inRange).not.toContain("172.20.5.9");
      expect(inRange).toContain("[redacted-private-endpoint]");
    });

    it("does NOT redact a 172.x address outside the 16-31 RFC1918 sub-range (e.g. 172.15.x or 172.32.x are public-range shaped)", () => {
      // 172.16.0.0/12 covers only 172.16.x through 172.31.x — 172.15.x and 172.32.x are outside
      // RFC1918 and must not be treated as private addresses by this pattern.
      expect(scrubString("Public-looking address 172.15.1.1")).toBe("Public-looking address 172.15.1.1");
      expect(scrubString("Public-looking address 172.32.1.1")).toBe("Public-looking address 172.32.1.1");
    });

    it("redacts the endpoint including a trailing path", () => {
      const input = "GET http://192.168.1.10:9301/mcp/schemas returns the tool list.";
      const out = scrubString(input);
      expect(out).not.toContain("192.168.1.10");
      expect(out).not.toContain("/mcp/schemas");
      expect(out).toContain("[redacted-private-endpoint]");
    });

    it("redacts an endpoint with NO tenant clause the same as before (tenant capture is optional, doesn't change the base endpoint match)", () => {
      const input = "GET http://10.1.2.3:8080/status with no tenant mentioned at all.";
      const out = scrubString(input);
      expect(out).not.toContain("10.1.2.3");
      expect(out).toContain("[redacted-private-endpoint]");
      expect(out).not.toContain("tenant [redacted-tenant]"); // no tenant clause was present, none should be synthesized
    });

    it("redacts BOTH the endpoint AND its adjacent tenant clause even when the endpoint has a trailing PATH before the comma (comma-consumption regression)", () => {
      // Adversarial case found via direct regex testing (not the real corpus this time): the
      // path-matching group originally allowed a literal comma inside a matched path, so an
      // endpoint WITH a trailing path immediately followed by ", tenant <name>" had its path group
      // greedily consume the comma too, leaving the tenant clause with nothing to anchor on —
      // "tenant first" would survive as unredacted literal text. Fixed by excluding `,` from the
      // path group's character class. The real leak's own phrasing has no trailing path before its
      // tenant clause, so this exact combination never occurred in the actual corpus — this test
      // exists so the fix doesn't silently regress if a future corpus/title ever has this shape.
      const input = "First endpoint http://192.168.1.1:8080/path, tenant first and second http://10.0.0.1, tenant second.";
      const out = scrubString(input);
      expect(out).not.toContain("192.168.1.1");
      expect(out).not.toContain("10.0.0.1");
      expect(out).not.toMatch(/tenant\s+first\b/);
      expect(out).not.toMatch(/tenant\s+second\b/);
      expect(out).toMatch(/tenant \[redacted-tenant\].*tenant \[redacted-tenant\]/s);
    });

    it("does NOT redact a tenant-shaped phrase merely starting the NEXT LINE after an unrelated endpoint's trailing comma (newline-adjacency regression, found by independent review)", () => {
      // Found by an independent adversarial review pass, not the real corpus: `\s` (used around
      // "tenant" in the tenant-clause group) matches a literal newline, so an endpoint at the end
      // of one line followed by a bare trailing comma, with an UNRELATED "tenant <word>" phrase
      // merely happening to start the very next line, was treated as one syntactically-adjacent
      // match — exactly the "spurious adjacency across unrelated content" failure mode the whole
      // combined-pattern design exists to avoid (see PRIVATE_ENDPOINT_RE's own doc comment,
      // "ATTEMPT 2" — this is a milder recurrence of that same failure mode via a line break
      // instead of a large aggregated file). Fixed by using `[^\S\n]` (whitespace-but-not-newline)
      // instead of `\s` around "tenant" in the tenant-clause group — same-line adjacency (the real
      // leak's actual phrasing) is unaffected; only a tenant-word starting the NEXT line no longer
      // attaches.
      const input = "example-host is at 10.9.9.9,\ntenant unrelated appears on the next line by coincidence.";
      const out = scrubString(input);
      expect(out).not.toContain("10.9.9.9");
      expect(out).toContain("[redacted-private-endpoint]");
      expect(out).toContain("tenant unrelated appears on the next line by coincidence."); // UNCHANGED, not redacted
      expect(out).not.toContain("[redacted-tenant]");
    });
  });

  describe("direction 2 — ordinary multi-tenancy architecture prose is NOT redacted (no whole-string/whole-file gate to accidentally trip)", () => {
    it("does not redact 'tenant' used as a common noun with no identifier attached", () => {
      const cases = [
        "Monet multi-tenancy — isolated PostgreSQL schema per tenant.",
        "Default Guidance (tenant-wide policy), Shared rules (agent-group).",
        "NextAuth with providers tenant-oauth / platform-oauth / dev-bypass.",
      ];
      for (const c of cases) {
        expect(scrubString(c), `expected "${c}" to survive unredacted`).toBe(c);
      }
    });

    it("does NOT redact 'tenant <ordinary-technical-noun>' with no private endpoint anywhere near it — the direct false-positive check", () => {
      // A direct query of every real "tenant <word>" occurrence in eval-corpus/source/monet.db
      // turned up 16 matches; only ONE ("tenant acme") is a real tenant identifier. The other 15
      // are ordinary architecture-documentation nouns. None of these strings contain a private
      // endpoint at all, so the combined pattern's tenant-capture group never has anything to
      // attach to — these survive unconditionally, by construction, not via any separate gate.
      const cases = [
        "Monet multi-tenancy — isolated PostgreSQL schema per tenant; ensureTenantSchemasCurrent reviews tenant DDL, with backfill needed for new tenants.",
        "MULTI-TENANT — per-tenant Postgres schema, isolation modes, Keycloak OIDC/SSO, agent",
        "Tenant MCP handshake is customizable: tenant_settings + /admin",
        "erred; preserve service types via MCP decoration. Tenant vs platform-level configuration is documented separately.",
      ];
      for (const c of cases) {
        expect(scrubString(c), `expected "${c}" to survive unredacted (no private endpoint present)`).toBe(c);
      }
    });

    it("does NOT redact a tenant-shaped phrase with NO private endpoint immediately adjacent, even when a DIFFERENT private endpoint exists elsewhere in the SAME string — the whole-file-aggregation regression this fix's final design specifically closes", () => {
      // THE decisive real-corpus bug (found regenerating the actual pipeline, not hypothetically):
      // index.md aggregates ALL 172 concepts' one-line summaries into ONE file/string. A prior
      // design gated tenant redaction on "does this whole string contain ANY private endpoint" —
      // which meant the example-host concept's endpoint (present ANYWHERE in that huge aggregated
      // file) silently authorized redacting an unrelated concept's "reviews tenant DDL" sentence
      // many thousands of characters away, in a totally different part of the document. This test
      // reproduces that exact shape (one endpoint, one unrelated tenant-word phrase, both present
      // in the same string but with no syntactic relationship between them) and asserts the
      // tenant-word phrase survives — the ONLY thing that should ever get redacted is the endpoint
      // itself, since the tenant clause requires direct adjacency (", tenant <name>" immediately
      // following the endpoint match), which this input deliberately does not have.
      const input =
        "example-host reachable at http://192.168.1.10:9301 for ops. " +
        "Unrelated elsewhere in this same document: ensureTenantSchemasCurrent reviews tenant DDL, with backfill needed.";
      const out = scrubString(input);
      expect(out).not.toContain("192.168.1.10"); // the actual endpoint IS still redacted
      expect(out).toContain("[redacted-private-endpoint]");
      expect(out).toContain("reviews tenant DDL, with backfill needed"); // the unrelated phrase survives, UNCHANGED
      expect(out).not.toContain("[redacted-tenant]"); // no tenant clause was ever adjacent to the endpoint, so none is synthesized
    });

    it("ACCEPTED, DOCUMENTED LIMITATION: does NOT redact a bare back-reference to an already-defined tenant name elsewhere in the SAME concept, when it's not immediately adjacent to the endpoint", () => {
      // The real leaked concept (example-host) mentions its tenant identifier "acme" a SECOND time,
      // in a separate paragraph, as a bare "the acme endpoint" reference with no literal word
      // "tenant" nearby at all and no private endpoint immediately before it. A same-string
      // co-reference mechanism that would catch this WAS implemented and found unsafe (see the
      // whole-file-aggregation regression test above) — the safe, syntactically-local fix cannot
      // recover this second mention without reintroducing that same risk. This is flagged
      // explicitly as a known, accepted gap rather than silently left untested: the endpoint
      // itself and its immediately-adjacent tenant clause ARE always caught (see direction 1's
      // "redacts the exact real leak" test); only a later, non-adjacent bare back-reference is not.
      const input = "REVERSIBLE: re-register example-remote (user scope, http transport + bearer auth → the acme endpoint) to restore live access.";
      expect(scrubString(input)).toBe(input);
    });

    it("does not redact an ordinary public IP address (not RFC1918-shaped)", () => {
      const input = "The public endpoint is at 8.8.8.8 for reference.";
      expect(scrubString(input)).toBe(input);
    });

    it("does not redact a version-number-shaped string that merely resembles an IP octet run", () => {
      // Sanity check: something like "192.168" alone (no full 4-octet run) should not match.
      const input = "Released in changelog entry 192.168 (not a real version, just a test string).";
      expect(scrubString(input)).toBe(input);
    });
  });
});

describe("scrubFilenameIfNeeded — P1-b fix (round 2): sensitive topic-file slugs (defense-in-depth safety net)", () => {
  // IMPORTANT SCOPE NOTE: this function is a SECONDARY safety net, not the primary fix. The
  // primary fix is md-export-store.ts scrubbing a concept's TITLE (via scrubString, the FULL
  // pattern set) BEFORE calling slugify() on it, while the title's original separators (/Users/,
  // ~/, @, IP-address dots) are still intact — see md-export-store.test.ts's own "P1-b fix" suite
  // for coverage of the actual real-world leak (a title containing "/Users/dev/...", a tilde
  // path, or an email, all correctly producing a clean slug via that upstream fix).
  //
  // This safety net exists for a DIFFERENT, narrower purpose: catching a leak if the
  // title-scrub-before-slug step is ever bypassed at some future call site, operating on whatever
  // basename actually landed on disk. Because it necessarily runs AFTER slugify() has already
  // collapsed every separator into a hyphen, it uses scrubSlugSafe (not the full scrubString) —
  // testing THIS function against a hand-constructed "already-slugified" fixture (e.g.
  // "build-plan-doc-...-users-dev-.md", no leading slash) correctly returns null, because
  // "users-dev" alone (no "/Users/" substring) was never something ANY regex operating on an
  // already-slugified string could recover — that leak is only fixable upstream, which is exactly
  // what md-export-store.ts now does. Tests below are scoped to what this narrower safety net
  // actually does and does not do, verified empirically rather than asserted from what would be
  // convenient.
  describe("direction 1 — a filename carrying a residual, slug-detectable signal IS renamed", () => {
    it("renames a basename that contains a literal, still-recognizable email address (@ intact) — the one shape scrubSlugSafe reliably catches", () => {
      // A REAL post-slugify() basename never literally contains '@' (slugify() replaces it with a
      // hyphen before the file ever reaches disk) — this test instead documents scrubSlugSafe's
      // EMAIL_RE pass working correctly on ANY string containing a literal '@', proving the
      // function isn't a no-op, using an input that (unlike a real slugified basename) still has
      // the separator intact. This matters because scrubFilenameIfNeeded is reused verbatim
      // regardless of whether some future caller passes it a not-fully-slugified string.
      const used = new Set();
      const renamed = scrubFilenameIfNeeded("contact-info-jane.doe@example.com.md", used);
      expect(renamed).not.toBeNull();
      expect(renamed).not.toContain("jane.doe@example.com");
    });
  });

  describe("direction 2 — real, verified gaps against REAL (already-slugified) input — all closed instead by the upstream md-export-store.ts fix", () => {
    it("does NOT rename the exact real leak on its own (users-dev has no leading slash once slugified) — this is why the PRIMARY fix lives upstream", () => {
      const used = new Set();
      expect(scrubFilenameIfNeeded("build-plan-doc-written-2026-06-30-users-dev-.md", used)).toBeNull();
    });

    it("does NOT rename an already-slugified private RFC1918 endpoint (IP-octet dots destroyed by slugify — the real example-host leak's filename)", () => {
      // Real leaked filename: "example-host-the-remote-server-monet-at-http-192" (truncated at
      // slugify()'s 48-char limit). PRIVATE_ENDPOINT_RE requires a dotted-octet shape a slug
      // (hyphens instead of dots) no longer has.
      const used = new Set();
      expect(scrubFilenameIfNeeded("example-host-the-remote-server-monet-at-http-192.md", used)).toBeNull();
    });

    it("does NOT rename an already-slugified sk-/key_/AKIA-shaped secret", () => {
      // sk- is a DELIBERATE trade (see the false-positive test below for why scrubSlugSafe
      // excludes SECRET_RE entirely, not just the sk- alternative); key_/AKIA never survive
      // slugification's underscore/casing destruction regardless.
      const used = new Set();
      expect(scrubFilenameIfNeeded("leaked-key-sk-abcdefghijklmnopqrst.md", used)).toBeNull();
      expect(scrubFilenameIfNeeded("leaked-key-key-abcdefghijklmnop.md", used)).toBeNull();
      expect(scrubFilenameIfNeeded("akia1234567890abcdef-leaked.md", used)).toBeNull();
    });

    it("returns null for a slug with no scrubbable content", () => {
      const used = new Set();
      expect(scrubFilenameIfNeeded("monet-multi-tenancy-architecture.md", used)).toBeNull();
    });

    it("returns null for non-.md basenames (chunks.json/corpus.json/index.md keep their fixed names)", () => {
      const used = new Set();
      expect(scrubFilenameIfNeeded("chunks.json", used)).toBeNull();
      expect(scrubFilenameIfNeeded("corpus.json", used)).toBeNull();
      expect(scrubFilenameIfNeeded("index.md", used)).toBeNull();
    });
  });

  describe("direction 3 — false positives this safety net must NOT introduce (the bug actually found while writing these tests)", () => {
    it("does NOT false-positive on ordinary hyphenated sk-<word> slugs (scrubSlugSafe's whole reason for existing, distinct from scrubString)", () => {
      // THE false-positive bug found while writing these tests: scrubString's SECRET_RE guard is
      // tuned against SPACE-separated prose ("sk-authored the design doc" correctly survives) but
      // NOT against HYPHEN-joined slugs ("sk-authored-design-notes" — the identical phrase,
      // slugified — WOULD incorrectly match SECRET_RE's sk- alternative, since the character class
      // includes hyphens and keeps consuming across what used to be word boundaries). All 4 of
      // scrubString's own documented false-positive examples, converted to slug form, are asserted
      // clean here.
      const used = new Set();
      const guardCases = [
        "sk-authored-design-notes.md",
        "sk-fixture-data-for-the-test.md",
        "sk-based-approach-to-caching.md",
        "sk-file-naming-convention.md",
      ];
      for (const c of guardCases) {
        expect(scrubFilenameIfNeeded(c, used), `expected ${c} to survive unrenamed`).toBeNull();
      }
    });
  });

  describe("collision disambiguation and re-slugified output shape (independent of which pattern actually fired)", () => {
    it("disambiguates a collision introduced by two different filenames scrubbing to the same name", () => {
      const used = new Set();
      const first = scrubFilenameIfNeeded("contact-a@example.com-note.md", used);
      const second = scrubFilenameIfNeeded("contact-b@example.com-note.md", used);
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first).not.toBe(second);
    });

    it("never leaves a literal bracket/placeholder token in the renamed filename (re-slugified, not just substituted)", () => {
      const used = new Set();
      const renamed = scrubFilenameIfNeeded("contact-jane.doe@example.com-about-the-project.md", used);
      expect(renamed).not.toBeNull();
      expect(renamed).not.toMatch(/[[\]]/);
      expect(renamed).toMatch(/^[a-z0-9-]+\.md$/);
    });
  });
});

describe("assertDerivedDbExists — P2-b fix (round 2 review): fail loudly on a missing derived DB", () => {
  describe("direction 1 — a missing db for a size that has an md export throws", () => {
    it("throws when the expected monet.db is absent", () => {
      const dir = mkdtempSync(join(tmpdir(), "scrub-p2b-"));
      try {
        const mdSizeDir = join(dir, "md", "25");
        mkdirSync(mdSizeDir, { recursive: true });
        const missingDbPath = join(dir, "db", "25", "monet.db"); // deliberately never created
        expect(() => assertDerivedDbExists(missingDbPath, "25", mdSizeDir)).toThrow(/derived db not found/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("throw message names the specific size and both the missing db path and the md dir that DID exist (actionable, not generic)", () => {
      const dir = mkdtempSync(join(tmpdir(), "scrub-p2b-"));
      try {
        const mdSizeDir = join(dir, "md", "100");
        mkdirSync(mdSizeDir, { recursive: true });
        const missingDbPath = join(dir, "db", "100", "monet.db");
        try {
          assertDerivedDbExists(missingDbPath, "100", mdSizeDir);
          expect.unreachable("expected assertDerivedDbExists to throw");
        } catch (err) {
          const message = (err as Error).message;
          expect(message).toContain('"100"');
          expect(message).toContain(missingDbPath);
          expect(message).toContain(mdSizeDir);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("direction 2 — a present derived db does NOT throw (no false-positive failure on the normal, complete-pipeline case)", () => {
    it("does not throw when the db file actually exists", () => {
      const dir = mkdtempSync(join(tmpdir(), "scrub-p2b-"));
      try {
        const mdSizeDir = join(dir, "md", "50");
        mkdirSync(mdSizeDir, { recursive: true });
        const dbDir = join(dir, "db", "50");
        mkdirSync(dbDir, { recursive: true });
        const dbPath = join(dbDir, "monet.db");
        writeFileSync(dbPath, "", "utf8"); // presence is all this check asserts, not validity of contents
        expect(() => assertDerivedDbExists(dbPath, "50", mdSizeDir)).not.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
