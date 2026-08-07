/**
 * Retrieval arms — the things the eval compares.
 *
 * Every arm answers the same question ("given this query, which concept ids would the
 * agent get back, in rank order?") so a metric is just: did the gold concept land in the
 * top-k? Arms are how we keep the eval honest: each new recall mechanism is added here and
 * must BEAT `monet-search` on the same scenarios to earn its place.
 *
 * An unavailable arm (`available: false`) is reported, never silently skipped — a blank
 * column would read as "covered" when it isn't.
 */
import type { MonetCore } from "../engine";

export interface RetrievalArm {
  name: string;
  /** False ⇒ not run; the harness records it with `unavailableReason` instead of metrics. */
  available: boolean;
  unavailableReason?: string;
  /** Concept ids in rank order for `query`, capped at k. Empty = retrieved nothing. */
  retrieve(core: MonetCore, query: string, opts: { circle: string; k: number }): Promise<string[]>;
}

/** The status quo: an agent with no persistent memory. Recalls nothing — the baseline to beat. */
export const noMemoryArm: RetrievalArm = {
  name: "no-memory",
  available: true,
  async retrieve() {
    return [];
  },
};

/** What ships today: tier-1 structural search over the concept store (ADR §4.5). */
export const monetSearchArm: RetrievalArm = {
  name: "monet-search",
  available: true,
  async retrieve(core, query, { circle, k }) {
    const cards = await core.search(query, { circle, limit: k });
    return cards.map((c) => c.id);
  },
};

/** The arms run by default. */
export const DEFAULT_ARMS: RetrievalArm[] = [noMemoryArm, monetSearchArm];
