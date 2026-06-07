/**
 * Eval scenarios — coding-agent memory tasks.
 *
 * Each scenario is a memory loop split across a session boundary:
 *   - seed:   what an EARLIER session learned (stored as observations).
 *   - probes: decision points in a LATER session — after the live context is gone —
 *             where the agent needs that prior knowledge. A probe is satisfied iff the
 *             retrieval arm surfaces the gold concept(s) in its top-k.
 *
 * Probe categories map 1:1 to the three metrics the eval reports (ADR §4.7 / roadmap):
 *   - "mistake"     → repeated-mistake rate      (a recorded gotcha/correction must resurface)
 *   - "reexplain"   → re-explain rate            (an established fact/decision must resurface)
 *   - "restoration" → context-restoration recall (rebuild a whole thread from durable concepts)
 *
 * Gold is referenced by a logical `key` assigned at seed time, NOT a conceptId: dedup
 * (#239) may collapse several seeds into one concept, so the harness maps key→conceptId
 * AFTER seeding, and a probe's `gold` resolves to that concept set. This keeps scenarios
 * declarative and robust to how the substrate chooses to merge evidence.
 */

export type ProbeCategory = "mistake" | "reexplain" | "restoration";

export interface Seed {
  /** Logical handle for gold references. Two seeds MAY share a key to assert a merge. */
  key: string;
  content: string;
  kind?: string;
}

export interface Probe {
  category: ProbeCategory;
  /** The agent's situation/intent at this decision point — the retrieval query. */
  query: string;
  /** Logical keys whose concept(s) MUST surface for the probe to be satisfied. */
  gold: string[];
  /** What real failure this probe stands in for. */
  note: string;
}

export interface Scenario {
  id: string;
  title: string;
  /** What memory failure this scenario represents in real coding-agent work. */
  rationale: string;
  seed: Seed[];
  /** Decoys in their OWN prior sessions: never gold, pressure ranking (a real store is noisy). */
  distractors?: Seed[];
  /**
   * Unrelated facts touched in the SAME session as the thread (realistic tangents). They are
   * never gold but DO co-occur with the gold members — so co_occurred is not a pristine
   * gold-only clique, and gather must rank the thread above its own session noise. This is the
   * realistic (not best-case) co-occurrence model the restoration win is measured under.
   */
  tangents?: Seed[];
  probes: Probe[];
}

/**
 * The starter suite. Deliberately spans:
 *   - lexically-strong probes (1,2,3,5,6) — pass even on the lexical fallback embedder,
 *   - one paraphrase-only probe (4) — passes on MiniLM, exposes the lexical embedder's gap,
 *   - one multi-gold restoration probe (5) — the case plain top-k search under-serves and
 *     the #245 graph-backed `gather` is meant to close (seed→spread→stop).
 */
/**
 * Shared background corpus — plausible coding-agent memories seeded into EVERY scenario
 * so the store is realistically noisy and top-k retrieval is actually selective. Without
 * this, a handful of concepts ≤ k means search returns the whole store and every probe
 * trivially "passes" — measuring nothing. Clusters deliberately sit ADJACENT to the gold
 * topics (other build/db/auth/deploy/port facts) so the gold must out-rank real neighbors,
 * not just unrelated noise. None of these is ever gold (keys are `bg:*`).
 */
export const BACKGROUND: Seed[] = [
  // build / tooling — neighbors of build-gotcha
  { key: "bg:turbo", content: "The monorepo uses Turborepo; `turbo run build` orchestrates per-package builds with caching." },
  { key: "bg:tsc", content: "Type checking runs via `tsc --noEmit`; the build emits with a separate tsconfig.build.json." },
  { key: "bg:esbuild", content: "The CLI is bundled with esbuild into a single file in build.mjs." },
  { key: "bg:node", content: "The project targets Node 20+; nvm reads .nvmrc for the pinned version." },
  { key: "bg:pnpm-ws", content: "pnpm workspaces are defined in pnpm-workspace.yaml; install at the root only." },
  // storage / db — neighbors of storage-decision
  { key: "bg:migrations", content: "Server DB migrations live in apps/api/migrations and run on deploy via drizzle." },
  { key: "bg:pgvector", content: "The server tier uses pgvector for embedding search in Postgres." },
  { key: "bg:sqlitevec", content: "The local tier uses sqlite-vec for the on-disk vector index." },
  { key: "bg:redis", content: "A Redis cache fronts hot read queries on the server." },
  { key: "bg:pool", content: "The API uses a Postgres connection pool sized to 10 by default." },
  // style / lint — neighbors of code-style
  { key: "bg:eslint", content: "ESLint enforces no-unused-vars and import/order; warnings fail CI." },
  { key: "bg:naming", content: "Files are kebab-case; React components are PascalCase." },
  { key: "bg:imports", content: "Imports are sorted: node builtins, then external, then internal aliases." },
  // ci / deploy — neighbors of deploy-gate
  { key: "bg:docker", content: "Production images are built with a multi-stage Dockerfile and pushed to GHCR." },
  { key: "bg:staging", content: "Every merge to main auto-deploys to the staging environment first." },
  { key: "bg:envvars", content: "Runtime config comes from environment variables validated with zod at boot." },
  { key: "bg:cron", content: "Scheduled jobs run via a GitHub Actions cron workflow nightly at 02:00 UTC." },
  { key: "bg:rollback", content: "Rollbacks redeploy the previous image tag from the registry." },
  // auth — neighbors of auth-refactor
  { key: "bg:oauth", content: "Third-party login uses OAuth via the provider's authorization-code flow." },
  { key: "bg:pwhash", content: "Passwords are hashed with argon2id before storage." },
  { key: "bg:cors", content: "CORS allows only the dashboard origin; credentials are included." },
  { key: "bg:ratelimit", content: "The API rate-limits unauthenticated requests to 60/min per IP." },
  { key: "bg:cookies", content: "Session cookies are httpOnly, secure, and SameSite=Lax." },
  // ports / services — neighbors of port-correction
  { key: "bg:redis-port", content: "Local Redis listens on port 6379." },
  { key: "bg:api-port", content: "The API server listens on port 8080 in development." },
  { key: "bg:grafana", content: "The local Grafana dashboard is served on port 3001." },
  // misc realistic noise
  { key: "bg:logging", content: "Structured logs are emitted as JSON via pino." },
  { key: "bg:telemetry", content: "OpenTelemetry traces are exported to the local collector when enabled." },
  { key: "bg:flags", content: "Feature flags are read from a flags table and cached for 60s." },
  { key: "bg:webhooks", content: "Stripe webhooks are verified with the signing secret before processing." },
  { key: "bg:i18n", content: "UI strings are localized through next-intl message catalogs." },
  { key: "bg:queue", content: "Background work is enqueued to a BullMQ queue backed by Redis." },
  { key: "bg:email", content: "Transactional email is sent through Postmark templates." },
  { key: "bg:search-ui", content: "The dashboard search box debounces input by 200ms before querying." },
  { key: "bg:upload", content: "File uploads go directly to S3 via presigned URLs." },
  { key: "bg:tests-fixtures", content: "Test fixtures are seeded from factories under tests/factories." },
];

export const STARTER_SUITE: Scenario[] = [
  {
    id: "build-gotcha",
    title: "Native-rebuild build gotcha",
    rationale:
      "A recorded gotcha must resurface when the agent is about to repeat it — even surrounded by unrelated repo facts.",
    seed: [
      {
        key: "build-gotcha",
        kind: "issue",
        content:
          "Gotcha: never run `pnpm build` at the repo root — it rebuilds the native better-sqlite3 binding and fails CI. Build per-package with `pnpm --filter <pkg> build`.",
      },
    ],
    distractors: [
      { key: "d-next", content: "The dashboard is a Next.js app-router project under apps/dashboard." },
      { key: "d-routes", content: "API routes live under apps/api/src/routes and use Hono." },
      { key: "d-vitest", content: "Unit tests run on Vitest; e2e tests use Playwright." },
    ],
    probes: [
      {
        category: "mistake",
        query: "I'm about to run pnpm build at the root to compile everything before pushing.",
        gold: ["build-gotcha"],
        note: "Without recall the agent reruns the root build and breaks CI again.",
      },
    ],
  },
  {
    id: "storage-decision",
    title: "Local storage: SQLite over Postgres",
    rationale: "An established decision (+ rejected alternative) must resurface so it isn't re-litigated.",
    seed: [
      {
        key: "storage-decision",
        kind: "decision",
        content:
          "We chose SQLite (better-sqlite3) for the local tier over Postgres: zero-config, no daemon, single-file. Postgres was rejected for local — it is the server tier only.",
      },
    ],
    distractors: [
      { key: "d-embed", content: "Local embeddings use all-MiniLM-L6-v2 via transformers.js (ONNX)." },
      { key: "d-mcp", content: "The engine is exposed to agents over an MCP stdio server." },
    ],
    probes: [
      {
        category: "reexplain",
        query: "Should the local runtime use Postgres or SQLite for its storage backend?",
        gold: ["storage-decision"],
        note: "Without recall the user must re-explain a decision already made (and the rejected option).",
      },
    ],
  },
  {
    id: "code-style",
    title: "Repo code conventions",
    rationale: "Conventions must resurface so generated code matches the house style without re-asking.",
    seed: [
      {
        key: "code-style",
        kind: "preference",
        content:
          "Code style: 2-space indentation, no semicolons, double quotes, prettier config in .prettierrc. Do not reformat unrelated lines in a PR.",
      },
    ],
    distractors: [{ key: "d-ci", content: "CI runs lint, typecheck, and tests on every pull request." }],
    probes: [
      {
        category: "reexplain",
        query: "What indentation and formatting conventions does this repo use?",
        gold: ["code-style"],
        note: "Without recall the agent guesses style and the user re-explains it every session.",
      },
    ],
  },
  {
    id: "deploy-gate",
    title: "Deploy gated on e2e (paraphrase recall)",
    rationale:
      "Semantic recall: the probe shares almost no vocabulary with the memory. Lexical retrieval misses it; a real embedding model should not.",
    seed: [
      {
        key: "deploy-gate",
        kind: "fact",
        content:
          "Deployment to production is gated on the end-to-end suite under tests/e2e; if e2e is red, the deploy workflow is skipped.",
      },
    ],
    distractors: [
      { key: "d-branch", content: "main is protected; merges require one approving review." },
      { key: "d-secrets", content: "Release credentials are stored in the CI secret store, not in the repo." },
    ],
    probes: [
      {
        category: "reexplain",
        query: "My merge to main didn't ship to production — why might that have happened?",
        gold: ["deploy-gate"],
        note: "Paraphrase: surfaces the lexical-vs-semantic gap and the payoff of the real embedder.",
      },
    ],
  },
  {
    id: "auth-refactor",
    title: "Restore the sign-in thread",
    rationale:
      "Context restoration: one intent must pull back the WHOLE thread — three concepts worked on together in one session but worded so none restates the intent and they share NO common entity. Plain top-k similarity recovers the closest one or two; the rest return via SAME-SESSION CO-OCCURRENCE (the signal that records 'these were worked on together'), not entity edges (which here connect at most 1 of 3 — see the reachability report). The realistic test: the work session also held unrelated tangents, so gather must rank the thread above its own session noise.",
    seed: [
      {
        key: "auth-task",
        kind: "fact",
        content: "Session validation is being moved out of the Hono middleware into a dedicated AuthService class.",
      },
      {
        key: "auth-decision",
        kind: "decision",
        content: "We standardized on the `jose` library for verifying signed tokens, replacing `jsonwebtoken`.",
      },
      {
        key: "auth-openq",
        kind: "issue",
        content: "Unresolved: how to rotate long-lived refresh credentials without dropping users who are already logged in.",
      },
    ],
    tangents: [
      { key: "auth-tan1", content: "Also bumped the linter to flag floating promises." },
      { key: "auth-tan2", content: "Renamed the staging banner copy while in here." },
    ],
    distractors: [
      { key: "d-billing", content: "Billing uses Stripe webhooks handled in apps/api/src/billing." },
      { key: "d-ui", content: "The account settings page lives in apps/dashboard/app/settings." },
    ],
    probes: [
      {
        category: "restoration",
        query: "Get me back into the user sign-in work from last session.",
        gold: ["auth-task", "auth-decision", "auth-openq"],
        note: "Lexically-divergent thread recovered via session co-occurrence, not entity edges; tangents pressure precision.",
      },
    ],
  },
  {
    id: "port-correction",
    title: "Corrected dev-server port",
    rationale: "The CURRENT value must out-rank a stale one; surfacing it (not the stale note) stops the repeated mistake.",
    seed: [{ key: "port-new", kind: "fact", content: "The dev server currently runs on port 5173 (the Vite dev server)." }],
    distractors: [
      { key: "d-port-old", content: "Older docs mention the dev server on port 3000 — no longer accurate." },
      { key: "d-db-port", content: "Local Postgres for the server tier listens on port 5432." },
    ],
    probes: [
      {
        category: "mistake",
        query: "What port does the dev server run on?",
        gold: ["port-new"],
        note: "Among several port facts (incl. the stale 3000 note), the current one must surface on top.",
      },
    ],
  },
  {
    id: "test-deadlock",
    title: "Don't run e2e + unit together",
    rationale: "A test-isolation gotcha must out-rank generic testing facts when the agent is about to trip it.",
    seed: [
      {
        key: "test-deadlock",
        kind: "issue",
        content:
          "Gotcha: never run the e2e and unit suites in the same process — they share one test database and deadlock. Run e2e separately with --runInBand.",
      },
    ],
    distractors: [{ key: "d-coverage", content: "Coverage is collected with v8 and uploaded to Codecov." }],
    probes: [
      {
        category: "mistake",
        query: "I'll just run the whole test suite at once before opening the PR.",
        gold: ["test-deadlock"],
        note: "Competes with the background Vitest/coverage facts; the gotcha must rank above them.",
      },
    ],
  },
  {
    id: "migration-edit",
    title: "Never edit an applied migration",
    rationale: "A correction supersedes earlier advice; the resolved rule must surface so the agent doesn't rewrite history.",
    seed: [
      {
        key: "mig-new",
        kind: "correction",
        content: "Rule: never edit a migration that has already been applied — add a NEW migration instead.",
      },
    ],
    distractors: [
      { key: "d-mig-old", content: "Older guidance: to change the schema, edit the latest migration file under apps/api/migrations." },
    ],
    probes: [
      {
        category: "mistake",
        query: "I need to change a column type, so I'll edit the most recent migration file.",
        gold: ["mig-new"],
        note: "The current rule must out-rank the stale edit-in-place note so the mistake isn't repeated.",
      },
    ],
  },
  {
    id: "error-convention",
    title: "Errors as Result, not thrown",
    rationale: "A convention worded differently from the query (paraphrase) must still resurface.",
    seed: [
      {
        key: "error-convention",
        kind: "preference",
        content:
          "Service functions return a Result type; never throw across the service boundary. One middleware maps errors to HTTP status codes.",
      },
    ],
    distractors: [{ key: "d-sentry", content: "Unhandled exceptions are reported to Sentry in production." }],
    probes: [
      {
        category: "reexplain",
        query: "How should a service-layer function signal that something went wrong?",
        gold: ["error-convention"],
        note: "Paraphrase of 'return a Result, don't throw'; competes with logging/Sentry background.",
      },
    ],
  },
  {
    id: "pkg-manager",
    title: "pnpm only",
    rationale: "An established tool choice must resurface so the agent doesn't reach for npm/yarn.",
    seed: [
      {
        key: "pkg-manager",
        kind: "decision",
        content: "This repo uses pnpm exclusively; the lockfile is pnpm-lock.yaml and CI fails if npm or yarn is used.",
      },
    ],
    probes: [
      {
        category: "reexplain",
        query: "Can I add a dependency with `npm install`?",
        gold: ["pkg-manager"],
        note: "Competes with the background pnpm-workspace / turbo facts.",
      },
    ],
  },
  {
    id: "branching",
    title: "Trunk-based workflow",
    rationale: "A workflow convention worded differently from the query must resurface despite deploy-flavored competition.",
    seed: [
      {
        key: "branching",
        kind: "preference",
        content: "Trunk-based development: short-lived feature branches, squash-merge into main, no long-running release branches.",
      },
    ],
    distractors: [{ key: "d-review", content: "Pull requests need one approving review before merge." }],
    probes: [
      {
        category: "reexplain",
        query: "What's our process for getting a finished feature into production?",
        gold: ["branching"],
        note: "Paraphrase; competes with the staging/deploy background — a deliberately hard re-explain.",
      },
    ],
  },
  {
    id: "search-thread",
    title: "Restore the search-feature thread",
    rationale: "A second restoration thread with divergent member wording, recovered via session co-occurrence — coverage beyond the sign-in thread; includes in-session tangents so co-occurrence isn't a pristine gold clique.",
    seed: [
      { key: "srch-task", kind: "fact", content: "Building full-text search over stored concepts with SQLite FTS5." },
      {
        key: "srch-decision",
        kind: "decision",
        content: "Search results are capped at 20 with a 'show more' affordance instead of pagination.",
      },
      {
        key: "srch-openq",
        kind: "issue",
        content: "Unresolved: how to combine lexical FTS scores with vector-similarity scores — there is no hybrid ranking yet.",
      },
    ],
    tangents: [{ key: "srch-tan1", content: "Bumped the Node version in CI while working here." }],
    probes: [
      {
        category: "restoration",
        query: "Pick up where I left off on the search feature.",
        gold: ["srch-task", "srch-decision", "srch-openq"],
        note: "Thread coverage; the hybrid-ranking open question is the divergent member plain search tends to drop.",
      },
    ],
  },
  {
    id: "incident-thread",
    title: "Restore the prod-incident thread",
    rationale: "A larger (4-concept) restoration thread — recall over more members is where plain top-k drops most and gather wins biggest; recovered via session co-occurrence (no shared entity links symptom→cause→fix), with an in-session tangent for realism.",
    seed: [
      { key: "inc-symptom", kind: "issue", content: "Production returned intermittent 500s under load last Tuesday." },
      { key: "inc-cause", kind: "fact", content: "Traced to the database client running out of available connections during sustained traffic." },
      { key: "inc-mitigation", kind: "decision", content: "Mitigation applied: raised the connection ceiling and added a per-statement timeout." },
      { key: "inc-followup", kind: "issue", content: "Still open: a slow N+1 query in the dashboard feed that triggered the pileup." },
    ],
    tangents: [{ key: "inc-tan1", content: "Updated the on-call rota doc while writing this up." }],
    probes: [
      {
        category: "restoration",
        query: "Remind me what the production outage we were debugging involved.",
        gold: ["inc-symptom", "inc-cause", "inc-mitigation", "inc-followup"],
        note: "Four-member thread with divergent vocabulary across symptom / cause / fix / follow-up.",
      },
    ],
  },
  {
    id: "checkout-thread",
    title: "Restore the checkout-refactor thread (entity-cohesive)",
    rationale: "A restoration thread whose members DO share a rare entity (the CheckoutService class), so entity `about` edges genuinely carry within-gold recall (≈3/3 in the reachability report) — the case the ADR's 'entity is the strongest anchor' claim refers to, and proof the entity machinery, not just co-occurrence, does real work.",
    seed: [
      { key: "co-task", kind: "fact", content: "Splitting tax math out of the CheckoutService into its own collaborator." },
      { key: "co-decision", kind: "decision", content: "The CheckoutService will call a new TaxService per line item rather than inline." },
      { key: "co-openq", kind: "issue", content: "Open in the CheckoutService work: how to round multi-currency totals consistently." },
    ],
    tangents: [{ key: "co-tan1", content: "Tidied an unrelated typo in the README while here." }],
    probes: [
      {
        category: "restoration",
        query: "Help me resume the checkout refactor.",
        gold: ["co-task", "co-decision", "co-openq"],
        note: "Entity-cohesive thread: about edges (shared CheckoutService) carry recall here, complementing co-occurrence.",
      },
    ],
  },
];
