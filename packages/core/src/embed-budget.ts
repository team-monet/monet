/**
 * The retrieval-quality budget, in the embedder's own tokens.
 *
 * It lives in its own module because BOTH ends of the rule need it and they must not import each
 * other: `engine.ts` reads it to put guidance inside the window-refusal error, and
 * `observation-segmenter.ts` reads it to size a segment. `engine.ts` re-exports it, so every existing
 * consumer — including `index.ts`'s public surface — is unaffected by where it is defined.
 */

/**
 * The size below which retrieval measures reliable on this store: unrelated pairs shorter than this
 * score 0.0% at or above tauAttach, while pairs three times longer cross it 93.3% of the time
 * (scripts/repros — the length-band table in docs/design/bounded-retrieval-unit.md).
 *
 * ADVISORY AT THE WRITE BOUNDARY, ENFORCED IN THE SEGMENTER. Refusing a write at this number would
 * turn away a large share of legitimate single-claim writes to buy a quality gradient, and a refusal
 * has its own cost — so the enforced line for a WRITE stays at the model's window, where the failure
 * is irreversible data loss rather than degraded ranking. The number is not abandoned there, it moves
 * to where it costs nothing: `segmentTokenBudget` caps every indexed span at
 * `min(RELIABLE_EMBED_TOKENS, provider window)`, so ranking happens at a granularity the model reads
 * reliably no matter how long the observation the author chose to write.
 *
 * Shipping only the advisory half is what left the live corpus inside the collapse zone the design
 * doc named — measured in #155 at 41.5% of unrelated observation pairs clearing tauAttach.
 */
export const RELIABLE_EMBED_TOKENS = 280;
