/**
 * DOES gather() FIND WHAT search() FINDS? (#155 follow-up.)
 *
 *   MONET_DB=/path/to/copy.db npx tsx scripts/measure-gather-recall.ts
 *
 * search() and gather() share one scorer and diverge only in what happens after it. Both now take the
 * lexically-ranked score into `sim`; gather then hands it to fuse(), which ADDS a graph term
 * (`s + beta * incoming`) and scores anything the scorer did not reach as
 * `beta * activation * prior^priorExp` — a branch with no relevance term at all.
 *
 * On the live store after the bge migration, search returns the right concepts for a short natural
 * question while gather returns large, frequently-touched ones. This measures that gap instead of
 * asserting it, by running BOTH arms over identical intents and comparing where the home concept
 * lands. What remains after #160 is the fusion constants, tracked in monet-core#161.
 *
 * THE INTENT is an observation's opening sentence, and nothing is withheld — the question is "can
 * this store surface what it holds", which is what a reader actually asks of it. Identical intents go
 * to both arms, so the comparison isolates the fusion stage and nothing else.
 *
 * The eval gates cannot see this: they run on HashingEmbeddingProvider, where the lexical arm is off
 * and `rank` is a copy of `score`, so search and gather order identically there by construction. That
 * is precisely the fixture-adequacy trap this issue documents, which is why this runs on the live
 * corpus in the shipping space.
 *
 * Read-only against the store it is pointed at; point it at a copy.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

import { realpathSync } from "node:fs";

import Database from "better-sqlite3";
import { MonetCore } from "../src/engine";
import { chooseStartupEmbedder, resolveDbPath } from "./mcp-cli";

const DB = process.env.MONET_DB!;
const SAMPLE = Number(process.env.SAMPLE ?? 200);
const LIMIT = Number(process.env.LIMIT ?? 10);

const opening = (text: string): string =>
  ((text.trim().split(/(?<=[.!?])\s+|\n/u).filter((s) => s.trim().length >= 40)[0]) ?? text).slice(0, 220);

interface Tally { r1: number; r5: number; r10: number; found: number; mrr: number; n: number }
const blank = (): Tally => ({ r1: 0, r5: 0, r10: 0, found: 0, mrr: 0, n: 0 });
const record = (t: Tally, rank: number): void => {
  t.n++;
  if (rank <= 0) return;
  t.found++;
  if (rank === 1) t.r1++;
  if (rank <= 5) t.r5++;
  if (rank <= 10) t.r10++;
  t.mrr += 1 / rank;
};

async function main(): Promise<void> {
  /*
   * REFUSE THE LIVE STORE (Codex, PR #160). The header says "point it at a copy", but the code opens
   * MONET_DB through the ordinary writable MonetCore path and calls ensureEmbedderPin() — which on a
   * pre-pin store MINTS a pin and on an older schema runs migrations. A measurement script must not
   * be the thing that changes what it is measuring, and an instruction in a comment is not a guard.
   */
  // Ask the resolver that OWNS the path rather than reimplementing it (Codex, PR #160 round 3): the
  // CLI resolves MONET_STORAGE_DIR, then a project `.monet`, then the home one, and appends its own
  // filename — a hand-written check for a single path misses every other way a developer reaches the
  // live store, which is precisely the store this refusal exists to protect.
  // Compare FILE IDENTITY, not pathname (Codex, PR #160 round 4). resolve() normalizes a path but
  // does not follow a symlink, so a link pointing at the live database walked straight through a
  // guard whose entire job is to refuse it.
  const canonical = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };
  const live = resolveDbPath();
  if (canonical(DB) === canonical(live) && process.env.ALLOW_LIVE !== "1") {
    console.error(`refusing to run against the live store (${live}); copy it first, or set ALLOW_LIVE=1`);
    process.exit(2);
  }
  const probe = new Database(DB, { readonly: true });
  // Pick the largest RETRIEVABLE circle, under the same predicate the probe query uses (Codex, PR
  // #160 round 4). Counting workstreams, retired and connector-owned rows can elect a circle that is
  // largest only because of them, and the run then measures a tiny filtered remainder — a difference
  // in the selector reported as a difference in fusion.
  const circle = (probe.prepare(
    `SELECT c.circle AS circle, COUNT(*) n
       FROM observations o JOIN concepts c ON c.id = o.concept_id
      WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL AND o.kind != 'source'
        AND c.kind NOT IN ('workstream', 'source')
        AND c.source_identity IS NULL AND c.active_observation_id IS NULL AND c.status != 'retired'
      GROUP BY c.circle ORDER BY n DESC LIMIT 1`,
  ).get() as { circle: string }).circle;
  const rows = probe.prepare(
    `SELECT o.id, o.concept_id AS cid, o.content
       FROM observations o JOIN concepts c ON c.id = o.concept_id
      WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
        AND o.kind != 'source' AND c.circle = ?
        -- Only concepts the read arms can actually RETURN (Codex, PR #160). A workstream, a retired
        -- concept or a connector-owned row is excluded from search()/gather() candidates by design,
        -- so probing for one scores a structural impossibility as a miss and understates both arms.
        AND c.kind NOT IN ('workstream', 'source')
        AND c.source_identity IS NULL AND c.active_observation_id IS NULL AND c.status != 'retired'
      ORDER BY o.id`,
  ).all(circle) as Array<{ id: string; cid: string; content: string }>;
  probe.close();

  // Fixed, PROPORTIONAL indexes — repeatable across a code change, and spanning the whole circle
  // (Codex, PR #160 round 5). A floor-based stride plus slice() kept only the earliest ids, and the
  // query orders by id, so the report could carry temporal bias reported as fusion behaviour.
  const take = Math.min(SAMPLE, rows.length);
  const probes = Array.from({ length: take }, (_, k) => rows[Math.floor((k * rows.length) / take)]);

  const core = new MonetCore(DB, { embedder: await chooseStartupEmbedder(DB) });
  await core.ensureEmbedderPin();

  const s = blank(), g = blank();
  let refused = 0;
  for (const p of probes) {
    const intent = opening(p.content);
    // An opening sentence can trip the script gate even when the whole observation does not — an
    // English observation whose first line quotes Korean. Those intents are unaskable on this pin,
    // so they are skipped and counted rather than crashing the run or being scored as a miss.
    try {
      const cards = await core.search(intent, { circle, limit: LIMIT });
      const gathered = await core.gather(intent, { circle, limit: LIMIT });
      record(s, cards.findIndex((c) => c.id === p.cid) + 1);
      record(g, gathered.ranked.findIndex((c) => c.id === p.cid) + 1);
    } catch (e) {
      if ((e as Error).name !== "ContentScriptUnsupportedError") throw e;
      refused++;
    }
  }
  core.close();

  console.log(`circle=${circle}  ${probes.length} intents (opening sentences), limit=${LIMIT}`);
  console.log(`${refused} refused by the script gate (opening line quotes another script)\n`);
  // Report only the cut-offs the run actually asked for: with LIMIT below 10 an "R@10" column would
  // be computed from a list truncated at LIMIT and would read as a miss that never had a chance.
  const cuts = [1, 5, 10].filter((k) => k <= LIMIT);
  if (s.n === 0) {
    // NaN in every column reads as a completed run that found nothing, which is the opposite of the
    // truth: nothing was scoreable at all.
    console.error(`no scoreable probes — every sampled intent was refused. Widen SAMPLE or the circle.`);
    process.exit(1);
  }
  console.log(`  arm      ${cuts.map((k) => `R@${k}`.padStart(6)).join("  ")}  in-list     MRR`);
  for (const [name, t] of [["search", s], ["gather", g]] as const) {
    const pct = (x: number) => `${((x / t.n) * 100).toFixed(1)}%`.padStart(6);
    const at: Record<number, number> = { 1: t.r1, 5: t.r5, 10: t.r10 };
    console.log(`  ${name.padEnd(8)} ${cuts.map((k) => pct(at[k])).join("  ")}  ${pct(t.found)}  ${(t.mrr / t.n).toFixed(4)}`);
  }
  console.log(`\n  Identical intents through both arms. They share the scorer, so any gap is the fusion`);
  console.log(`  stage: fuse() adds a graph term to sim, and scores anything the scorer did not reach`);
  console.log(`  as beta * activation * prior^priorExp — a branch with no relevance term at all.`);
}
void main();
