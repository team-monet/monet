/**
 * Calibrate / re-verify the STORE-TIME RESOLUTION bands (src/resolution.ts) — "find by evidence,
 * confirm by identity".
 *
 *   npx tsx scripts/measure-resolution-bands.ts                    # lexical (CI) embedder only
 *   MONET_EVAL_ONNX=1 npx tsx scripts/measure-resolution-bands.ts   # + MiniLM, the shipping space
 *
 * WHY THIS LIVES IN THE REPO. The hybrid rule REUSES tauAttach/tauAmbiguous — the embedder's own
 * recommendedThresholds — but applies them to a different quantity than they were calibrated on:
 * obs-vs-obs cosine, not obs-vs-centroid. Obs-vs-obs runs HIGHER (a centroid dilutes; a single
 * observation vector does not), so the same numbers are STRICTER in evidence space than they were
 * in identity space. That is the conservative direction — a wrong fork is recoverable by merge, a
 * wrong merge loses provenance — but "conservative" is a claim about a distribution, and a claim
 * about a distribution has to be measured or it is a guess. Deliberately no new threshold knob was
 * introduced; this script is how anyone who wants one argues for it. Reporting only; in-memory
 * store, never writes files, always exits 0.
 *
 * METHOD — TWO FIXTURES, because one of them cannot see the effect being measured.
 *
 *   A. NATURAL INGEST. The eval corpus (src/eval/scenarios.ts BACKGROUND + every STARTER_SUITE
 *      seed, tangent and distractor) streamed into one store at the embedder's OWN recommended
 *      thresholds — production behavior exactly, dedup on. This is the realistic case, and its
 *      finding is a NEGATIVE one worth stating plainly: the corpus is 98 deliberately-distinct
 *      memories, so it barely consolidates (1.0-1.1 observations/concept), and on a store of
 *      single-observation concepts a centroid IS its one observation vector — the two rules are
 *      arithmetically identical there. Fixture A therefore measures the SAFETY of the change (it
 *      changes nothing where nothing has consolidated) and cannot measure its EFFECT.
 *
 *   B. CONSOLIDATED. The effect only exists on multi-observation concepts, so this fixture builds
 *      them the way a store acquires them: each scenario's seeds + tangents + its own distractors
 *      attached into ONE concept. That grouping is not invented — the corpus already labels those
 *      items as topically ADJACENT BUT DISTINCT ("decoys in their own prior sessions"), which is
 *      exactly the composition of a concept that has over-absorbed: heterogeneous evidence under
 *      one identity, i.e. a bimodal concept with a blurred centroid. Then BACKGROUND is streamed in
 *      as incoming evidence against it. This is where blur attractors and fork signals can appear
 *      at all, and it is the fixture the band mapping has to survive.
 *
 * In both fixtures, before each write, both scans run against the store as it stands:
 *
 *   NOMINATION (new rule)   max cosine over each concept's live observation vectors -> argmax
 *   CENTROID ARGMAX (old)   cosine against each concept's centroid -> argmax
 *
 * so every ingest yields a paired sample and the two rules' decisions on identical input.
 *
 * FOUR THINGS TO READ.
 *
 *   1. THE TWO DISTRIBUTIONS side by side. If nomination scores were NOT systematically higher, the
 *      unit split's whole premise (a centroid points at nothing in particular) would be wrong.
 *
 *   2. DECISION MIX under each rule. This is the mis-calibration alarm: on a realistic corpus,
 *      neither "everything attaches" nor "nothing ever attaches" is a healthy answer. The corpus is
 *      built of DISTINCT memories (each seed is its own fact, and distractors are deliberate
 *      near-misses), so a high create rate is CORRECT here and a high attach rate would be the
 *      alarming reading.
 *
 *   3. THE TWO DEFECT CLASSES this slice kills, counted on real inputs:
 *      BLUR ATTRACTOR — old rule would have ATTACHED (centroid >= tauAttach) while no single
 *      observation agrees (obs < tauAmbiguous): evidence-free absorption, now a create.
 *      FORK SIGNAL — evidence agrees (obs >= tauAttach) but the target's centroid has drifted
 *      (< tauAmbiguous): a bimodal concept, previously a SILENT new concept with no edge, now
 *      forked WITH a possible_duplicate_of edge.
 *
 *   4. MEMBER CONFIRMATION (the confirm band's own safety margin). After ingest, every live
 *      observation is scored against ITS OWN concept's centroid. Any member below tauAmbiguous is a
 *      concept that would now VETO the attachment of its own evidence — the fork-signal pressure
 *      that centroid dilution creates. A small tail is the design working (that IS bimodality); a
 *      large one would mean the confirm band is cutting into ordinary consolidation and tauAmbiguous
 *      is the wrong number for this job.
 */
import { AmbiguousNominationError, MonetCore } from "../src/engine";
import { HashingEmbeddingProvider, cosine, isZeroVector, jsonToEmb, type EmbeddingProvider } from "../src/embedding";
import { printProviderIdentity, printSyntheticStoreHeader } from "./measure-header";
import { resolveIncoming, type ResolutionMode, type ResolutionNomination } from "../src/resolution";
import { STARTER_SUITE, BACKGROUND, type Seed } from "../src/eval/scenarios";
import type { StoragePort } from "../src/storage";

const CIRCLE = "default";

const dbOf = (core: MonetCore): StoragePort => (core as unknown as { db: StoragePort }).db;

/** The full ingest stream, in a realistic interleaved order (background first, then each scenario). */
function corpus(): Seed[] {
  const items: Seed[] = [...BACKGROUND];
  for (const scenario of STARTER_SUITE) {
    items.push(...scenario.seed, ...(scenario.tangents ?? []), ...(scenario.distractors ?? []));
  }
  return items;
}

interface CandidateRow { id: string; embedding: string }

/** The candidate set the engine's own store path enumerates (live, non-workstream). */
function candidates(db: StoragePort): CandidateRow[] {
  return db
    .prepare(
      `SELECT id, embedding FROM concepts
        WHERE circle = ? AND kind != 'workstream' AND status != 'retired'`,
    )
    .all(CIRCLE) as CandidateRow[];
}

/**
 * Per-concept MAX cosine over live observation vectors — the nomination scan, re-implemented
 * standalone (like measure-recall-floor.ts's own scorer) so the measurement stays valid if the
 * engine's filtering changes: a script that calls the thing it is auditing cannot detect the
 * audited thing drifting.
 */
function nominate(db: StoragePort, rows: CandidateRow[], emb: Float32Array): ResolutionNomination | null {
  const ids = new Set(rows.map((r) => r.id));
  const observations = db
    .prepare(
      `SELECT id, concept_id, embedding FROM observations
        WHERE concept_id IS NOT NULL AND kind != 'source'
          AND superseded_by IS NULL AND superseded_at IS NULL`,
    )
    .all() as Array<{ id: string; concept_id: string; embedding: string }>;
  const best = new Map<string, { score: number; observationId: string }>();
  for (const row of observations) {
    if (!ids.has(row.concept_id)) continue;
    const vec = jsonToEmb(row.embedding);
    if (isZeroVector(vec)) continue;
    const score = cosine(emb, vec);
    if (score <= 0) continue;
    const prior = best.get(row.concept_id);
    if (prior === undefined || score > prior.score || (score === prior.score && row.id < prior.observationId)) {
      best.set(row.concept_id, { score, observationId: row.id });
    }
  }
  let winner: ResolutionNomination | null = null;
  for (const row of rows) {
    const match = best.get(row.id);
    if (match === undefined) continue;
    if (winner !== null && (match.score < winner.obsScore || (match.score === winner.obsScore && row.id > winner.conceptId))) continue;
    winner = {
      conceptId: row.id, obsScore: match.score, observationId: match.observationId,
      centroidScore: cosine(emb, jsonToEmb(row.embedding)),
    };
  }
  return winner;
}

/** Argmax by CENTROID cosine — what resolution used to decide on, kept here as the counterfactual. */
function centroidArgmax(rows: CandidateRow[], emb: Float32Array): { conceptId: string; score: number } | null {
  let winner: { conceptId: string; score: number } | null = null;
  for (const row of rows) {
    const score = cosine(emb, jsonToEmb(row.embedding));
    if (score <= 0) continue;
    if (winner !== null && (score < winner.score || (score === winner.score && row.id > winner.conceptId))) continue;
    winner = { conceptId: row.id, score };
  }
  return winner;
}

const pct = (sorted: number[], p: number): number =>
  sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))];

const f = (x: number): string => (Number.isNaN(x) ? "  n/a " : x.toFixed(4));

function distribution(label: string, values: number[]): string {
  const s = [...values].sort((a, b) => a - b);
  return `${label.padEnd(22)} min=${f(s[0])} p25=${f(pct(s, 25))} p50=${f(pct(s, 50))} p75=${f(pct(s, 75))} p95=${f(pct(s, 95))} max=${f(s[s.length - 1])}  n=${s.length}`;
}

/**
 * Stream `incoming` into `core`, recording both rules' view of every write. `prebuilt` names how
 * the store was seeded, for the header line.
 */
async function measure(
  label: string,
  embedder: EmbeddingProvider,
  build: (core: MonetCore) => Promise<Seed[]>,
  measuredDim?: number,
): Promise<void> {
  // PRODUCTION THRESHOLDS, not the eval harness's dedup-off convention: this measurement is about
  // where the bands land, so the bands have to be the real ones and the store has to consolidate.
  const thresholds = embedder.recommendedThresholds ?? { tauAttach: 0.55, tauAmbiguous: 0.4 };
  let seq = 0;
  const core = new MonetCore(":memory:", { embedder, idGen: () => `c${(seq++).toString().padStart(6, "0")}` });
  try {
    const incoming = await build(core);
    const db = dbOf(core);
    const obsScores: number[] = [];
    const centroidScores: number[] = [];
    const oldDecision = { attached: 0, ambiguous: 0, created: 0 };
    const newModes = new Map<ResolutionMode, number>();
    let asks = 0;
    let blurAttractor = 0;
    let blurEdge = 0;
    let forkSignal = 0;
    let nothingNominated = 0;

    for (const item of incoming) {
      const emb = await embedder.embed(item.content);
      const rows = candidates(db);
      const nomination = nominate(db, rows, emb);
      const centroid = centroidArgmax(rows, emb);

      if (nomination === null) nothingNominated++;
      else {
        obsScores.push(nomination.obsScore);
        // Pair the centroid sample with the nomination sample: the same input, scored both ways.
        centroidScores.push(centroid?.score ?? 0);
        if (nomination.obsScore >= thresholds.tauAttach && nomination.centroidScore < thresholds.tauAmbiguous) forkSignal++;
        if ((centroid?.score ?? 0) >= thresholds.tauAttach && nomination.obsScore < thresholds.tauAmbiguous) blurAttractor++;
        // The same defect one band down: the centroid was near enough to mint a possible_duplicate_of
        // edge (and a nearMatch in the result) with no observation-level support behind it. Weaker
        // than absorption, but it is what puts noise into the curation queue.
        else if ((centroid?.score ?? 0) >= thresholds.tauAmbiguous && nomination.obsScore < thresholds.tauAmbiguous) blurEdge++;
      }

      const old = centroid === null || centroid.score < thresholds.tauAmbiguous
        ? "created"
        : centroid.score >= thresholds.tauAttach ? "attached" : "ambiguous";
      oldDecision[old]++;

      const decision = resolveIncoming({
        nomination,
        centroidTop: centroid ? { conceptId: centroid.conceptId, centroidScore: centroid.score } : null,
        kind: item.kind,
        thresholds,
      });
      newModes.set(decision.mode, (newModes.get(decision.mode) ?? 0) + 1);

      // THE STREAM MUST NOT STOP ON AN ASK (Codex P1, PR #87 round 7). `tauMargin` on the shipping
      // profile means the real store can now refuse an ambiguous write, while the local `nominate()`
      // above never computes a margin and so `resolveIncoming` here can never report one. Left
      // unhandled, the first ambiguous probe aborted the entire replay; recorded as an attach, the
      // run would claim a decision production refuses.
      //
      // So the ask is counted as its own outcome and the stream continues by naming the concept the
      // engine itself nominated — which is what a caller would do, and keeps the corpus growing the
      // way the rest of this measurement assumes. The count is reported beside the modes rather than
      // folded into them: an ask is not a resolution, and hiding it inside one would restate the
      // conflation this script exists to expose.
      try {
        await core.store(item.content, { circle: CIRCLE, kind: item.kind });
      } catch (e) {
        if (!(e instanceof AmbiguousNominationError)) throw e;
        asks++;
        const chosen = e.candidates[0]?.conceptId;
        await core.store(item.content, chosen === undefined
          ? { circle: CIRCLE, kind: item.kind, resolution: "forceNew" }
          : { circle: CIRCLE, kind: item.kind, attachTo: chosen });
      }
    }

    // Member confirmation: every live observation against its OWN concept's centroid.
    const members = db
      .prepare(
        `SELECT o.embedding AS obs, c.embedding AS centroid FROM observations o
           JOIN concepts c ON c.id = o.concept_id
          WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL AND o.kind != 'source'`,
      )
      .all() as Array<{ obs: string; centroid: string }>;
    const memberScores = members
      .map((m) => cosine(jsonToEmb(m.obs), jsonToEmb(m.centroid)))
      .filter((s) => Number.isFinite(s));
    const vetoed = memberScores.filter((s) => s < thresholds.tauAmbiguous).length;

    const conceptCount = (db.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE circle = ?`).get(CIRCLE) as { n: number }).n;
    const total = incoming.length;

    console.log(`\n===== ${label} =====`);
    // Four measurements run under three providers here, after one synthetic store header. The label
    // names the scenario and the provider class; this names the SPACE the bands below were seen in.
    printProviderIdentity(label, embedder, measuredDim);
    console.log(`thresholds  tauAttach=${thresholds.tauAttach}  tauAmbiguous=${thresholds.tauAmbiguous}`);
    console.log(`store       ${memberScores.length} observations / ${conceptCount} concepts (${(memberScores.length / conceptCount).toFixed(2)} observations per concept) after ${total} measured writes`);
    console.log(`\n1. SCORE DISTRIBUTIONS (paired, one sample per ingest that had any candidate)`);
    console.log(`   ${distribution("nomination (obs)", obsScores)}`);
    console.log(`   ${distribution("centroid argmax", centroidScores)}`);
    console.log(`   nothing nominated at all: ${nothingNominated} (empty store / no positive-cosine evidence)`);
    console.log(`\n2. DECISION MIX on identical inputs`);
    console.log(`   OLD (centroid only)  attached=${oldDecision.attached}  ambiguous=${oldDecision.ambiguous}  created=${oldDecision.created}`);
    console.log(`   NEW (hybrid)         ${[...newModes].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m}=${n}`).join("  ")}`);
    // BESIDE the modes, never inside one: an ask is not a resolution, and folding it into "attach"
    // would restate the conflation this script exists to expose.
    console.log(`   ASKS (refused, then answered by naming the engine's own top candidate)  ${asks}`);
    console.log(`\n3. DEFECT CLASSES on real inputs`);
    console.log(`   blur attractor  (old ABSORBED with no observation-level support):         ${blurAttractor}`);
    console.log(`     ^ now mode "blur-duplicate": created and PAIRED, never absorbed`);
    console.log(`   blur near-miss  (old minted a duplicate EDGE with no such support):       ${blurEdge}`);
    console.log(`     ^ now mode "new": no edge — a centroid merely NEAR is the related band's job`);
    console.log(`   fork signal     (evidence agrees, identity has drifted -> bimodal):       ${forkSignal}`);
    console.log(`\n4. MEMBER CONFIRMATION (each live observation vs its own concept's centroid)`);
    console.log(`   ${distribution("member vs centroid", memberScores)}`);
    console.log(`   below tauAmbiguous (own evidence would be vetoed): ${vetoed}/${memberScores.length} (${((vetoed / memberScores.length) * 100).toFixed(1)}%)`);

    // 5. IS tauAttach REACHABLE AT ALL in obs space? Sections 2-3 can report "nothing attached"
    // for two opposite reasons — a corpus of genuinely distinct memories (correct) or a threshold
    // no real input can clear (mis-calibration) — and they cannot tell them apart. These two
    // populations can:
    //   SELF        each stored item against the store that holds it. Cosine 1.0 by construction —
    //               the ceiling, and proof that an exact restatement always attaches.
    //   GOLD-LINKED each probe's text against its own gold concept. The corpus's only authored
    //               "same topic, different words" pairs. A LOWER BOUND on paraphrase similarity,
    //               because a probe is a QUESTION and a question matches a statement more weakly
    //               than a restatement of that statement would.
    // The band is healthy when it sits in the GAP between the distinct-memory distribution
    // (section 1) and these — not when it slices through either.
    // Gold keys are resolved through OBSERVATION CONTENT (stored verbatim), not through concept
    // title: a consolidated concept takes its title from whichever member created it, so a
    // title-keyed lookup would silently miss every attached member.
    const goldScores: number[] = [];
    const contentByKey = new Map(corpus().map((s) => [s.key, s.content]));
    const conceptOfContent = db.prepare(`SELECT concept_id FROM observations WHERE content = ? AND concept_id IS NOT NULL LIMIT 1`);
    const liveVectors = db.prepare(
      `SELECT embedding FROM observations WHERE concept_id = ? AND superseded_by IS NULL AND superseded_at IS NULL`,
    );
    for (const scenario of STARTER_SUITE) {
      for (const probe of scenario.probes) {
        const probeEmb = await embedder.embed(probe.query);
        for (const key of probe.gold) {
          const content = contentByKey.get(key);
          if (content === undefined) continue;
          const owner = conceptOfContent.get(content) as { concept_id: string } | undefined;
          if (owner === undefined) continue;
          const rows = liveVectors.all(owner.concept_id) as Array<{ embedding: string }>;
          const best = rows.map((r) => cosine(probeEmb, jsonToEmb(r.embedding))).reduce((a, b) => Math.max(a, b), 0);
          if (best > 0) goldScores.push(best);
        }
      }
    }
    console.log(`\n5. IS tauAttach REACHABLE? (distinct memories, section 1, vs genuine same-topic pairs)`);
    console.log(`   exact restatement scores 1.0000 by construction — always attaches, in either space.`);
    console.log(`   ${distribution("gold-linked probe", goldScores)}   <- lower bound (question vs statement)`);

    // The alarm decision 9 asks for, stated rather than left to the reader.
    const attachRate = (newModes.get("attach") ?? 0) / total;
    if (attachRate > 0.9) console.log(`\n  WARNING: ${(attachRate * 100).toFixed(0)}% of a corpus of DISTINCT memories attached — tauAttach reads too low in obs space.`);
    if (attachRate === 0 && obsScores.length > 0 && pct([...obsScores].sort((a, b) => a - b), 95) < thresholds.tauAttach * 0.5) {
      console.log(`\n  WARNING: nothing attached and even p95 nomination is far under tauAttach — tauAttach may read too high in obs space.`);
    }
  } finally {
    core.close();
  }
}

/** FIXTURE A — nothing pre-built; the whole corpus is the measured stream. */
const naturalIngest = async (): Promise<Seed[]> => corpus();

/**
 * FIXTURE B — one deliberately over-absorbed concept per scenario (seeds + tangents + that
 * scenario's own distractors, forced together with attachTo), then BACKGROUND as incoming.
 * attachTo is how consolidation actually happens (an agent or a human saying "this belongs with
 * that"), and it is the same construction the recall-unit-split tests use to build rich concepts.
 */
const consolidated = async (core: MonetCore): Promise<Seed[]> => {
  for (const scenario of STARTER_SUITE) {
    const members = [...scenario.seed, ...(scenario.tangents ?? []), ...(scenario.distractors ?? [])];
    const first = await core.store(members[0].content, { circle: CIRCLE, kind: members[0].kind });
    for (const member of members.slice(1)) {
      await core.store(member.content, { circle: CIRCLE, kind: member.kind, attachTo: first.conceptId });
    }
  }
  return [...BACKGROUND];
};

async function main(): Promise<void> {
  // No store to name: every `measure(...)` below builds its own :memory: MonetCore, so the space is
  // the provider each run is labelled with rather than a persisted pin.
  printSyntheticStoreHeader("one :memory: MonetCore seeded per measurement");
  const lexical = "HashingEmbeddingProvider (lexical — what CI runs)";
  await measure(`A. natural ingest — ${lexical}`, new HashingEmbeddingProvider(), naturalIngest);
  await measure(`B. consolidated store — ${lexical}`, new HashingEmbeddingProvider(), consolidated);
  if (process.env.MONET_EVAL_ONNX === "1") {
    const { OnnxEmbeddingProvider } = await import("../src/embedding-onnx");
    const onnx = new OnnxEmbeddingProvider();
    const warmup = await onnx.embed("warmup"); // force model load before anything is measured
    await measure(`A. natural ingest — ${onnx.modelId} (semantic — what ships)`, onnx, naturalIngest, warmup.length);
    await measure(`B. consolidated store — ${onnx.modelId} (semantic — what ships)`, onnx, consolidated, warmup.length);
  } else {
    console.log("\n(set MONET_EVAL_ONNX=1 to also measure the SHIPPING semantic space — the one the product resolves in)");
  }
}

void main();
