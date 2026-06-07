/**
 * The pure graph-retrieval core for gather() (#245, ADR §3.7/§4.7): deterministic
 * spreading activation → similarity-floored fusion → seed-relative evidence-gap stop.
 *
 * Kept DB-free on purpose: the engine reads edges from SQLite and supplies an `adjacency`
 * closure + a `sim` map; these functions do the math, so they unit-test on hand-built
 * fixtures with no store. Determinism is a hard requirement — every ranking tie breaks by id.
 */

/** A traversable edge as seen from a frontier node: the neighbour, the edge type, its weight. */
export interface Adj {
  dst: string;
  type: string;
  weight: number;
}

export interface GraphParams {
  /** Per-hop activation decay (HippoRAG-style damping). */
  gamma: number;
  /** Firing/dust threshold: activation below this neither spreads nor is contributed. */
  theta: number;
  /** Max hops from a seed (ADR k≤2). */
  hopLimit: number;
  /** How much graph activation is ADDED on top of a node's own similarity. */
  beta: number;
  /** Min fused score for a pure-graph (sim=0) node to be admitted. */
  includeFloor: number;
  /** Exponent on the ACT-R node prior (0 = ignore prior, 1 = full). */
  priorExp: number;
  /** Per-edge-type multiplier. */
  wType: Record<string, number>;
  /** Stop: accept floor = tauRel × top score. */
  tauRel: number;
  /** Stop: negligible-gain line = epsRel × top score. */
  epsRel: number;
  /** Stop: consecutive low-gain nodes before saturation break. */
  addWindow: number;
  /** Stop: hard cap on accepted nodes. */
  nodeBudget: number;
  /** Stop: never accept fewer than this (or seedCount) before any soft stop. */
  minNodes: number;
}

export const DEFAULT_GRAPH_PARAMS: GraphParams = {
  gamma: 0.5,
  theta: 0.05,
  hopLimit: 2,
  beta: 0.6,
  includeFloor: 0.1,
  priorExp: 0.5,
  // co_occurred elevated to the restoration tier (verified: it, not entity `about`, carries threads).
  wType: {
    about: 1.0,
    part_of: 0.9,
    supersedes: 0.9,
    co_occurred: 0.85,
    resolves: 0.85,
    derived_from: 0.8,
    supports: 0.75,
    contradicts: 0.7,
    related: 0.6,
    follows: 0.5,
  },
  tauRel: 0.3,
  epsRel: 0.05,
  addWindow: 3,
  nodeBudget: 24,
  minNodes: 3,
};

/**
 * Deterministic k≤hopLimit weighted spreading activation. `seeds` maps node → initial
 * activation; `adjacency(id)` returns that node's traversable edges. Activation accumulates
 * (sum) across paths; only the per-hop delta above `theta` propagates, which bounds fan-out.
 * Returns the full activation map (seeds included).
 */
export function spread(seeds: Map<string, number>, adjacency: (id: string) => Adj[], params: GraphParams): Map<string, number> {
  const activation = new Map(seeds);
  let frontier = new Map(seeds);
  for (let hop = 0; hop < params.hopLimit; hop++) {
    const next = new Map<string, number>();
    for (const [src, aSrc] of frontier) {
      if (aSrc < params.theta) continue;
      for (const e of adjacency(src)) {
        const delta = aSrc * params.gamma * (params.wType[e.type] ?? 0.5) * e.weight;
        if (delta < params.theta) continue;
        activation.set(e.dst, (activation.get(e.dst) ?? 0) + delta);
        next.set(e.dst, Math.max(next.get(e.dst) ?? 0, delta));
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }
  return activation;
}

export interface Ranked {
  id: string;
  score: number;
  viaSeed: boolean;
}

/**
 * Fuse thread/causal activation with raw similarity. The precision guard (the decisive design
 * choice): gather spreads ONLY over "worked-together / caused-by" edges (co_occurred, follows,
 * causal) — NOT about/related, which re-encode the similarity the seed already carries. So:
 *  - a similarity hit is boosted only by the thread spread it RECEIVES (incoming = activation −
 *    its own seed strength), never reshuffled by its own seed-set rank; and
 *  - a pure-graph node (no similarity) is admitted only when reached via thread/causal edges
 *    (β·activation over its ACT-R prior clears `includeFloor`).
 * A single-fact gold sits in a singleton session with no thread edges ⇒ nothing can displace it
 * ⇒ gather's single-fact ranking is byte-identical to search. Entity (`about`) still helps gather
 * — via entity-anchored SEEDING from the intent — just not via spread. Ranked desc, ties by id.
 */
export function fuse(
  activation: Map<string, number>,
  sim: Map<string, number>,
  seedStrength: Map<string, number>,
  priors: Map<string, number>,
  params: GraphParams,
): Ranked[] {
  const ids = new Set<string>([...activation.keys(), ...sim.keys()]);
  const out: Ranked[] = [];
  for (const id of ids) {
    const s = sim.get(id) ?? 0;
    if (s > 0) {
      const incoming = Math.max(0, (activation.get(id) ?? 0) - (seedStrength.get(id) ?? 0));
      out.push({ id, score: s + params.beta * incoming, viaSeed: true });
    } else {
      const a = activation.get(id) ?? 0;
      const prior = Math.max(priors.get(id) ?? 1, 1e-3);
      const score = params.beta * a * Math.pow(prior, params.priorExp);
      if (score >= params.includeFloor) out.push({ id, score, viaSeed: false });
    }
  }
  out.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return out;
}

export interface StopResult {
  accepted: Ranked[];
  stopReason: "floor" | "saturation" | "budget" | "exhausted";
}

/**
 * Seed-relative evidence-gap stop (MemR3 philosophy, rendered deterministically): stop adding
 * once marginal evidence is low. All thresholds are FRACTIONS of the top score, so they
 * self-normalise — a sharp single-fact query (tall top, high floor) collapses to ~1 node with
 * gold at rank 1; a flat multi-member field (restoration) keeps the floor open and admits the
 * whole thread. `novelty` (1 − max cosine to already-accepted) demotes paraphrase duplicates.
 */
export function evidenceGapStop(
  ranked: Ranked[],
  seedCount: number,
  embOf: (id: string) => Float32Array | null,
  cosine: (a: Float32Array, b: Float32Array) => number,
  params: GraphParams,
): StopResult {
  if (ranked.length === 0) return { accepted: [], stopReason: "exhausted" };
  const top = ranked[0].score;
  const floor = params.tauRel * top;
  const eps = params.epsRel * top;
  const minNodes = Math.max(params.minNodes, seedCount);
  const accepted: Ranked[] = [];
  let lowGainStreak = 0;
  let stopReason: StopResult["stopReason"] = "exhausted";

  for (const node of ranked) {
    if (accepted.length >= params.nodeBudget) {
      stopReason = "budget";
      break;
    }
    const belowMin = accepted.length < minNodes;
    if (node.score < floor && !belowMin) {
      stopReason = "floor";
      break;
    }
    const nodeEmb = embOf(node.id);
    let novelty = 1;
    if (nodeEmb) {
      let maxCos = 0;
      for (const a of accepted) {
        const e = embOf(a.id);
        if (e) maxCos = Math.max(maxCos, cosine(nodeEmb, e));
      }
      novelty = 1 - maxCos;
    }
    const gain = node.score * novelty;
    if (gain < eps && !belowMin) {
      if (++lowGainStreak >= params.addWindow) {
        stopReason = "saturation";
        break;
      }
      continue; // skip this redundant node, keep scanning
    }
    lowGainStreak = 0;
    accepted.push(node);
  }
  return { accepted, stopReason };
}

/** Reciprocal-rank fusion for building the SEED set only (dense+lexical scale mismatch). */
export function rrfFuse(rankings: string[][], k: number): Array<{ id: string; rrf: number }> {
  const score = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return [...score.entries()]
    .map(([id, rrf]) => ({ id, rrf }))
    .sort((a, b) => b.rrf - a.rrf || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
