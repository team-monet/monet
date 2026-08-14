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

/**
 * The reliable budget to actually use, given what a provider declared.
 *
 * ONE READ, ONE VALIDATION. This exists because there are two consumers — the segmenter, which cuts
 * text at the budget, and the window guard, which tells a refused caller what to aim for — and when
 * they each read `provider.reliableSegmentTokens ?? RELIABLE_EMBED_TOKENS` on their own, their
 * validation drifts apart. It did: the segmenter was hardened against a bogus declaration while the
 * guard kept forwarding it, so an `Infinity` declaration produced advice to stay under Infinity
 * tokens (Codex P2, PR #171, second round).
 *
 * A declaration is honoured only when it is a finite number of AT LEAST ONE token. Token counts are
 * non-negative integers, so anything under 1 — `0`, a negative, or a fractional `0.5` — leaves
 * hardCut's binary search unable to fit any non-empty prefix: `fit` stays at its initial 1 and the
 * text is emitted one CHARACTER at a time, one embedding call each. Anything else falls back, which
 * is a real measured number rather than a guess.
 */
export function reliableSegmentTokensOf(declared: number | undefined): number {
  return typeof declared === "number" && Number.isFinite(declared) && declared >= 1
    ? declared
    : RELIABLE_EMBED_TOKENS;
}
