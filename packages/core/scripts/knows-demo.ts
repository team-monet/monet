/**
 * "monet knows" wow-demo — run:  pnpm knows
 *
 * Three beats that make Monet's value visceral, all on the REAL
 * engine, with NO LLM and NO model download (lexical embedder), against a TEMP-FILE db so a
 * reopen genuinely reloads from disk:
 *   1. REMEMBERS ACROSS SESSIONS — a brand-new process restores the living model + where you
 *      left off from a session that no longer exists.
 *   2. STOPS REPEATING MISTAKES — a contradiction is surfaced (confidence visibly decays),
 *      then mediated — never silent last-write-wins.
 *   3. REBUILDS CLEAN CONTEXT AFTER A RESET — gather() pulls the whole thread (via the #245
 *      graph), including members a plain search would miss.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { MonetCore } from "../src/engine";
import { HashingEmbeddingProvider } from "../src/embedding";
import { renderOverview } from "../src/render-overview";

const CIRCLE = "payments-api";
const DB = join(tmpdir(), "monet-knows-demo.db");
const cleanup = (): void => {
  for (const ext of ["", "-wal", "-shm"]) rmSync(DB + ext, { force: true });
};
const opts = { embedder: new HashingEmbeddingProvider(), tauAttach: 1.1, tauAmbiguous: 1.1 } as const;
const rule = (s: string): void => console.log(`\n${"━".repeat(86)}\n${s}\n`);
const foot = (): void => console.log("\n   0 LLM calls · MiniLM-class footprint · no big local model required\n");

async function main(): Promise<void> {
  cleanup();

  // ── BEAT 0 — set the stage (Session A: the auth refactor) ──────────────
  const a = new MonetCore(DB, opts);
  const S = (content: string, kind: string): Promise<{ conceptId: string }> => a.store(content, { circle: CIRCLE, kind });
  const authId = (await S("Auth tokens are signed with jose (ES256), 15m TTL, issued by the AuthService.", "decision")).conceptId;
  await S("The AuthService lives in src/auth/service.ts and validates every request.", "fact");
  await S("Open: rotate the jose signing keys without dropping users already in the AuthService.", "issue");
  await a.saveWorkstream(
    { status: "active", nextSteps: ["wire jose key rotation"], openQuestions: ["how to roll keys without dropping sessions?"] },
    { circle: CIRCLE },
  );
  // Session B: payments work (a different sitting → its own co-occurrence thread).
  await S("Payments idempotency is keyed on the Stripe event id.", "decision");
  await S("Webhook retries double-charge when Stripe's 2xx is slow.", "issue");
  await S("ECONNREFUSED under load traced to the pgbouncer connection cap.", "insight");
  await S("Repo standard: pnpm + vitest, no jest.", "preference");
  a.endSessionForEval();
  // Long-term background, each learned in its own earlier session (realistic noise).
  for (const bg of [
    "The dashboard is a Next.js app-router project.",
    "CI runs lint, typecheck, and tests on every pull request.",
    "Production images are built with a multi-stage Dockerfile.",
    "Feature flags are cached for 60 seconds.",
    "Logs are emitted as JSON via pino.",
    "The API rate-limits anonymous requests to 60 per minute.",
    "Local Redis listens on port 6379.",
    "Uploads go straight to S3 via presigned URLs.",
    "Transactional email is sent through Postmark.",
    "Background jobs run on a BullMQ queue.",
    "OpenTelemetry traces export to the local collector.",
    "The marketing site is a separate Astro project.",
  ]) {
    await S(bg, "fact");
    a.endSessionForEval();
  }
  a.close();
  console.log("Session(s) over. The agent disconnects; the process exits. Memory is on disk.");

  // ── BEAT 1 — remembers across sessions ─────────────────────────────────
  rule("BEAT 1 · REMEMBERS ACROSS SESSIONS  (new process, zero prompt)");
  const b = new MonetCore(DB, opts);
  console.log(renderOverview(b.overview(CIRCLE)));
  console.log("\n→ A fresh process restored the LIVING MODEL and ACTIVE THREADS from sessions that no longer exist.");
  foot();

  // ── BEAT 2 — stops repeating mistakes ──────────────────────────────────
  rule('BEAT 2 · STOPS REPEATING MISTAKES  (a newer note contradicts a stored memory)');
  const contra = b.flagContradiction(authId, { detail: "Refresh-token TTL is 5m, not the 15m we assumed for access.", kind: "value-conflict" });
  console.log(renderOverview(b.overview(CIRCLE)));
  console.log("\n→ The conflict is SURFACED (see NEEDS ATTENTION) and the disputed memory's confidence visibly decayed — not silently overwritten.");
  b.resolveContradiction(contra.id, { decision: "accept-new", body: "Access token 15m TTL; refresh token 5m TTL (jose, ES256)." });
  console.log(renderOverview(b.overview(CIRCLE)));
  console.log("\n→ Mediated: the contradiction is resolved and confidence recovers.");
  foot();

  // ── BEAT 3 — rebuilds clean context after a reset ──────────────────────
  rule("BEAT 3 · REBUILDS CLEAN CONTEXT AFTER A RESET  (context window wiped)");
  const intent = "pick up the auth key-rotation work";
  const search = await b.search(intent, { circle: CIRCLE, limit: 10 });
  const g = await b.gather(intent, { circle: CIRCLE });
  console.log(`intent: "${intent}"  (the store holds ${b.overview(CIRCLE).counts.concepts} memories across many prior sessions)`);
  console.log(`  plain search → ${search.length} top-similar cards.`);
  console.log(`  gather → ${g.ranked.length} memories, spreading BEYOND the seeds through the graph: ${JSON.stringify(g.reachableByType)}`);
  console.log("   gather follows co-occurrence/causal links to rebuild the focused working set — not just keyword matches.");
  console.log("\nthe morning-after view:\n");
  console.log(renderOverview(b.overview(CIRCLE)));
  foot();

  b.close();
  cleanup();
}

main().catch((e) => {
  cleanup();
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
