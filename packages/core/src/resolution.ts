/**
 * Store-time resolution — FIND BY EVIDENCE, CONFIRM BY IDENTITY (design of record,
 * docs/design/next-monet-skeleton-gates-recall.md, "Store-time resolution"). The DECISION lives
 * here as a pure function; the engine executes it. (Refactoring-build directive: each subsystem
 * gets restructured as it is touched — src/retrieval.ts did this for the query arms in the recall
 * unit split, and this is its store-side twin.)
 *
 * THE SPLIT, APPLIED TO RESOLUTION. The recall slice established that a concept's
 * `concepts.embedding` is a running-mean centroid (blend(), embedding.ts) over everything ever
 * attached, so a many-observation concept embeds to a blurred mixture pointing at no one input in
 * particular. Retrieval fixed that by ranking on observation vectors. Resolution had the SAME
 * disease — "which concept does this incoming observation belong to?" was decided entirely by
 * cosine against those centroids — and the design's answer is a hybrid, not a second wholesale
 * swap:
 *
 *   OBSERVATION-LEVEL MATCHES NOMINATE the candidate concept (same architecture as recall), and
 *   THE CENTROID CONFIRMS COHERENCE — its second life after retiring from query ranking.
 *
 * TWO LIVE DEFECTS THIS KILLS.
 *
 *   1. THE BLUR ATTRACTOR (a misfile class). A big concept's blurred centroid sits near the middle
 *      of everything it has ever absorbed, so an unrelated incoming observation can score >=
 *      tauAttach against that mixture while agreeing with NO individual member observation. The old
 *      rule absorbed it anyway — evidence-free attachment, and the bigger and blurrier the concept
 *      the stronger its pull. Here the centroid has NO NOMINATION POWER: with no observation-level
 *      support at or above tauAmbiguous the store creates a new concept no matter how high the
 *      centroid cosine climbs — and, where that centroid claimed outright identity, PAIRS the two
 *      as a possible duplicate instead of leaving them unlinked (mode "blur-duplicate"; see
 *      createOrPair for why the kill on its own would leave an orphan pair).
 *
 *   2. THE SILENT SPLIT. The mirror image: an incoming observation that strongly matches a
 *      concept's MEMBER OBSERVATIONS while that concept's centroid has drifted below tauAmbiguous
 *      (bimodal concept — the mean of two clusters sits between them, near neither). The old rule
 *      saw a low centroid score, created a new concept, and recorded NOTHING: the duplicate pair
 *      never surfaced for mediation. Here that disagreement is not an error, it is the FORK SIGNAL
 *      — evidence says "same", identity says "not coherent", so the concept is bimodal and should
 *      SPLIT. It forks with a possible_duplicate_of edge, exactly the machinery the ambiguous band
 *      already uses, and the pair shows up in curation.
 *
 * WHY CONFIRM AT ALL. Observation-only matching is dangerous on its own: A~B, B~C, C~D chains a
 * concept into incoherence one attach at a time (the drift risk that kept resolution on centroids).
 * The centroid check bounds it — a concept that has already drifted incoherent cannot quietly
 * absorb more.
 *
 * THE BAND MAPPING (the FIRST of two interpretations this adds on top of the spec text, which names
 * the signals but not their threshold bands — flagged for review rather than buried; the second is
 * the symmetric blur-duplicate pairing, documented at createOrPair):
 *
 *   obsScore >= tauAttach   & centroidScore >= tauAmbiguous  -> ATTACH        (mode "attach")
 *   obsScore >= tauAttach   & centroidScore <  tauAmbiguous  -> FORK SIGNAL   (mode "fork-signal")
 *   tauAmbiguous <= obsScore < tauAttach                     -> ambiguous fork / correction attach
 *   obsScore <  tauAmbiguous & top centroid >= tauAttach     -> create + PAIR (mode "blur-duplicate")
 *   obsScore <  tauAmbiguous                                 -> CREATE        (mode "new")
 *
 * Confirmation is deliberately the WEAKER threshold. The spec's word is "far" — an incoming
 * observation "near member observations but far from the centroid" is the fork signal — so the
 * centroid must merely NOT BE FAR, not independently attach-strong. Requiring centroidScore >=
 * tauAttach would fork nearly every attach onto a consolidated concept (the blurred centroid is
 * exactly what fails a strong test) and would turn consolidation itself into a fork generator.
 * Below tauAmbiguous is the codebase's existing meaning of "not the same thing" — that is "far".
 *
 * THRESHOLDS ARE REUSED, NOT REINVENTED. tauAttach/tauAmbiguous are already embedder-derived
 * (EmbeddingProvider.recommendedThresholds; applyEmbedderDerivedThresholds in engine.ts) and this
 * slice adds no new knob. Obs-vs-obs cosines do run higher than obs-vs-centroid — the whole point,
 * since a centroid dilutes — so the same numbers are STRICTER in obs space, which is the
 * conservative direction for a resolution rule (a wrong fork is recoverable by merge; a wrong merge
 * loses provenance). Measured on the STARTER_SUITE corpus, see scripts/measure-resolution-bands.ts.
 *
 * SINGLE-OBSERVATION CONCEPTS ARE UNAFFECTED IN PRACTICE: their centroid IS their one observation
 * vector, so evidence and identity coincide and every band collapses to the old behavior.
 *
 * PURE: no db handle, no side effects, no clock. The engine performs the nomination scan, hands the
 * result here, and executes the returned decision inside its own transaction.
 */

/**
 * How one store() call resolved. Recorded on every write (`resolution_events`) and returned
 * additively as IngestResult.resolutionMode; the coarse `action` vocabulary
 * ("created"/"attached"/"ambiguous") is a public contract and is NOT changed by this slice, so
 * these modes are what distinguishes a fork signal from an ordinary ambiguous fork.
 *
 *   attach            evidence found and identity confirmed — absorbed into the nominated concept
 *   fork-signal       evidence found, identity DISAGREED — bimodal concept, forked for mediation
 *   species-fork      evidence and identity agreed, but the nominated concept kind was incompatible
 *   ambiguous-fork    ambiguous-band evidence — forked with a possible_duplicate_of edge (status quo)
 *   correction-attach ambiguous-band kind="correction" — attached, contradiction machinery takes over
 *   blur-duplicate    identity matched, evidence DISAGREED — the blur attractor's own output, paired
 *   new               no support from either signal — a genuinely new concept
 *   direct-attach     attachTo bypassed scoring entirely
 *   force-new         resolution:"forceNew" bypassed scoring entirely
 */
export type ResolutionMode =
  | "attach"
  | "fork-signal"
  | "species-fork"
  | "ambiguous-fork"
  | "correction-attach"
  | "blur-duplicate"
  | "new"
  | "direct-attach"
  | "force-new";

/**
 * The modes that record an actual RESOLUTION DECISION, as opposed to a caller who bypassed scoring
 * (attachTo / forceNew). This is the DENOMINATOR for every rate computed off `resolution_events`:
 * a store whose writes are mostly explicit attachTo — a bulk import, a consolidation session —
 * would otherwise show a fork rate diluted toward zero by writes that were never allowed to fork.
 */
export const DECIDED_RESOLUTION_MODES: readonly ResolutionMode[] = [
  "attach", "fork-signal", "species-fork", "ambiguous-fork", "correction-attach", "blur-duplicate", "new",
];

/** Whether `mode` recorded a resolution decision rather than a caller-directed bypass. */
export const isDecidedResolutionMode = (mode: string): boolean =>
  (DECIDED_RESOLUTION_MODES as readonly string[]).includes(mode);

/** The two embedder-derived bands the decision reads. Mirrors EmbeddingThresholds (embedding.ts). */
export interface ResolutionThresholds {
  tauAttach: number;
  tauAmbiguous: number;
}

/**
 * The winner of the observation-level nomination scan, plus the identity check on that same
 * concept. `null` at the call site means nothing was nominated at all — no live, non-zero,
 * positively-scoring observation vector anywhere in the circle.
 *
 * A ZERO-LIVE-OBSERVATION CONCEPT CANNOT BE NOMINATED (nothing to match): it is simply absent from
 * the scan, so incoming evidence near its centroid creates a fresh concept. That is the same hard
 * edge the recall split took — no centroid fallback — and it is deliberate: falling back would
 * reintroduce the blur attractor on exactly the rows least able to afford it.
 */
export interface ResolutionNomination {
  /** The nominated concept — argmax over per-concept best-observation cosine. */
  conceptId: string;
  /** That MAX cosine: how strongly the incoming evidence matches this concept's own evidence. */
  obsScore: number;
  /** WHICH observation produced obsScore. Instrumentation only; never influences the decision. */
  observationId: string;
  /** cosine(incoming, nominated concept's centroid) — the CONFIRMATION signal. */
  centroidScore: number;
}

/**
 * The top concept by CENTROID cosine — the same argmax resolution used before the split, kept
 * because the DISAGREEMENT it can have with the nomination is a signal in BOTH directions, and only
 * one of those directions needs a nomination to exist.
 *
 * It is NOT a fallback nomination and can never cause an attach (see resolveIncoming). Its only
 * power is to PAIR: when identity says "this is already here" and evidence says otherwise, the two
 * concepts are recorded as a possible duplicate for mediation instead of drifting apart unlinked.
 */
export interface ResolutionCentroidCandidate {
  conceptId: string;
  centroidScore: number;
}

export interface ResolutionInput {
  nomination: ResolutionNomination | null;
  /** Top concept by centroid cosine, if any scored above zero. Used ONLY for blur-duplicate pairing. */
  centroidTop?: ResolutionCentroidCandidate | null;
  /** The incoming observation's kind. Only "correction" changes the outcome (ambiguous band). */
  kind?: string;
  thresholds: ResolutionThresholds;
}

/** What the engine must execute. Exactly one of attachToConceptId / duplicateEdge is set (or neither, for a plain create). */
export interface ResolutionDecision {
  /** UNCHANGED public vocabulary. A fork signal reports "ambiguous" — behaviorally it IS one
   *  (create + possible_duplicate_of edge + nearMatch fields); `mode` carries the distinction. */
  action: "created" | "attached" | "ambiguous";
  mode: ResolutionMode;
  /** Set iff this decision lands the observation on an EXISTING concept. */
  attachToConceptId?: string;
  /**
   * Set iff this decision creates a concept AND links it to a near match for later mediation.
   *
   * WEIGHT RULE: the weight is the score that TRIGGERED THE PAIRING, which is not always the score
   * that drove the create — obsScore for fork-signal and ambiguous-fork (evidence found the
   * neighbour), centroidScore for blur-duplicate (identity did). Carrying it here rather than
   * letting the write site reach for `score` is what keeps that rule from being re-derived, and
   * wrongly, at the call site. (The two are on different scales — obs-vs-obs runs higher than
   * obs-vs-centroid — which is a known, deferred wrinkle in reading `possible_duplicate_of`
   * weights across modes; each weight is at least honest about what produced it.)
   */
  duplicateEdge?: { conceptId: string; weight: number };
  nearMatchId?: string;
  nearMatchScore?: number;
  /** The score that drove the RESOLVE-OR-CREATE decision: always the nomination's obsScore, 0 when
   *  nothing was nominated. Deliberately uniform across every auto mode — including blur-duplicate,
   *  where it is LOWER than nearMatchScore, because evidence is what decided not to attach. */
  score: number;
}

/**
 * THE decision. Auto-resolution only — `attachTo` and resolution:"forceNew" bypass scoring in the
 * engine and never reach here (they record modes "direct-attach"/"force-new" directly).
 *
 * Band boundaries are INCLUSIVE at the bottom (`>=`), matching the pre-split engine code exactly,
 * so a score sitting precisely on tauAttach attaches and one precisely on tauAmbiguous forks rather
 * than creating. Tie-breaking between equally-scoring candidates happens in the NOMINATION scan
 * (lower concept id wins), not here — by the time a nomination arrives there is exactly one.
 */
export function resolveIncoming(input: ResolutionInput): ResolutionDecision {
  const { nomination, kind } = input;
  const { tauAttach, tauAmbiguous } = input.thresholds;

  // Nothing in the circle's evidence matched at all. The centroid still cannot ATTACH anything —
  // it has no nomination power (defect 1) — but it can still PAIR: see createOrPair below.
  if (nomination === null) return createOrPair(input, 0);

  const { conceptId, obsScore, centroidScore } = nomination;

  if (obsScore >= tauAttach) {
    // Evidence says "same concept". Ask identity whether that concept is still coherent.
    if (centroidScore >= tauAmbiguous) {
      return { action: "attached", mode: "attach", attachToConceptId: conceptId, score: obsScore };
    }
    // THE FORK SIGNAL (defect 2): near the members, far from the centroid ⇒ bimodal. Fork and
    // surface the pair rather than deepening the incoherence. A wrong fork is recoverable (merge);
    // a wrong merge is not (a split loses provenance) — the same asymmetry the ambiguous band
    // already resolves in this direction, including for kind="correction": the correction exemption
    // below is scoped to the AMBIGUOUS band, where the doubt is about strength of match, not about
    // the target's coherence.
    return {
      action: "ambiguous",
      mode: "fork-signal",
      duplicateEdge: { conceptId, weight: obsScore },
      nearMatchId: conceptId,
      nearMatchScore: obsScore,
      score: obsScore,
    };
  }

  if (obsScore >= tauAmbiguous) {
    // AMBIGUOUS BAND — semantics preserved verbatim from the pre-split engine, only the score's
    // source moved from centroid to evidence. A wrong fork is recoverable; a wrong merge is not.
    if (kind === "correction") {
      // Exception (unchanged): the caller is explicitly asserting "this overrides existing memory",
      // so intent disambiguates. Attach to the nominated concept and let the contradiction
      // machinery take over. Nomination by evidence matters MOST here — a correction must land on
      // the concept whose EVIDENCE it corrects, not on whichever centroid happened to be nearest.
      return {
        action: "ambiguous",
        mode: "correction-attach",
        attachToConceptId: conceptId,
        nearMatchId: conceptId,
        nearMatchScore: obsScore,
        score: obsScore,
      };
    }
    return {
      action: "ambiguous",
      mode: "ambiguous-fork",
      duplicateEdge: { conceptId, weight: obsScore },
      nearMatchId: conceptId,
      nearMatchScore: obsScore,
      score: obsScore,
    };
  }

  // Below the ambiguous band: no evidence-level support, so nothing is absorbed however high a
  // centroid scored. That is the blur-attractor kill — and createOrPair is what keeps it from
  // leaving litter behind.
  return createOrPair(input, obsScore);
}

/**
 * THE SUB-BAND OUTCOME, and the second interpretive addition this slice makes on top of the spec
 * (the band mapping above is the first).
 *
 * EVIDENCE/IDENTITY DISAGREEMENT IS A SIGNAL IN BOTH DIRECTIONS. The spec names one of them —
 * obs-near + centroid-far is the fork signal, "the concept is bimodal and should split". Its mirror
 * is the blur attractor's own output: centroid-near + obs-far, where identity insists the store
 * already holds this and no stored evidence agrees. Killing the absorption (above) is only half the
 * fix; done alone it leaves an ORPHAN PAIR.
 *
 * Why an orphan, concretely: `related` edge derivation covers the band
 * [edgeSimMin, tauAttach) and deliberately EXCLUDES centroid scores at or above tauAttach (those
 * used to mean "same concept, attach" and so needed no edge). With the attach gone, a neighbour at
 * centroid >= tauAttach now gets no `related` edge, no `possible_duplicate_of` edge, and no entry
 * in any curation surface — the two concepts sit next to each other, invisible to the very
 * mediation the fork signal exists to trigger, linked at most by incidental same-session
 * co_occurred. So this branch emits the SAME possible_duplicate_of pairing the fork signal does,
 * with a mode that says which signal produced it.
 *
 * The pairing threshold is tauAttach, not tauAmbiguous, and that asymmetry is deliberate: a
 * centroid merely NEAR (the ambiguous band) is already served by `related` edges, and pairing there
 * would flood curation with every topical neighbour. Only a centroid claiming outright identity,
 * contradicted by the evidence, is worth a human's attention.
 *
 * kind="correction" gets NO exemption here. The ambiguous-band exemption exists because intent
 * disambiguates a weak EVIDENCE match; it cannot manufacture evidence that does not exist. A
 * correction whose only kinship with a concept is centroid-level must not be absorbed by it —
 * evidence-first is the whole design — so it creates and pairs like any other blur-duplicate, and
 * since it lands on no existing concept the engine opens no contradiction.
 */
function createOrPair(input: ResolutionInput, score: number): ResolutionDecision {
  const { centroidTop, thresholds } = input;
  if (centroidTop && centroidTop.centroidScore >= thresholds.tauAttach) {
    return {
      action: "ambiguous",
      mode: "blur-duplicate",
      duplicateEdge: { conceptId: centroidTop.conceptId, weight: centroidTop.centroidScore },
      nearMatchId: centroidTop.conceptId,
      nearMatchScore: centroidTop.centroidScore,
      score,
    };
  }
  return { action: "created", mode: "new", score };
}
