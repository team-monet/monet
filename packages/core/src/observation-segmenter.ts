/**
 * THE BOUNDED RETRIEVAL UNIT for native observations (docs/design/bounded-retrieval-unit.md).
 *
 * The recall unit split moved ranking off concept centroids and onto observations. This is the same
 * defect one level down, and the design doc states it on a postcard: *an observation is too big to be
 * a retrieval unit*. A long observation is one mean-pooled vector over many claims, so it points at
 * no one query in particular — and past the model's window its tail is in no vector at all.
 *
 * Measured on the live store before this shipped (#155, scripts/measure-threshold-headroom.ts):
 * observation pairs drawn from DIFFERENT concepts — the pairs store-time resolution exists to refuse
 * — cleared `tauAttach` 41.5% of the time. Re-scored at segment granularity that falls to 0.2%, and
 * separability on clean labels rises from AUC 0.7782 to 0.9119.
 *
 * WHY 280 AND NOT THE WINDOW. `RELIABLE_EMBED_TOKENS` is where retrieval measures reliable; the
 * window is merely where text starts being DISCARDED. The design doc is explicit that these are not
 * interchangeable: "a 512-token segment sits inside the collapse zone, where unrelated text already
 * scores 0.774 median and crosses tauAttach 64.5% of the time." So the budget is
 * `min(RELIABLE_EMBED_TOKENS, provider window)` — the constant sets it because retrieval quality is
 * measured here, and the provider caps it because exceeding the window is data loss.
 *
 * THIS IS WHERE 280 IS ENFORCED. At the write boundary it is deliberately advisory (engine.ts's
 * `RELIABLE_EMBED_TOKENS` note: refusing there "would refuse a large share of legitimate single-claim
 * writes"). The design never asked an agent to write shorter than 280 — it asked the store to RANK at
 * that granularity regardless of what was written. An advisory at the boundary and an enforced budget
 * here are two halves of one rule; shipping only the advisory leaves the corpus in the collapse zone
 * with nothing catching it, which is exactly the state #155 measured.
 *
 * NO OVERLAP between adjacent segments — ruled out in the design: it is the usual remedy for
 * boundary-straddling matches, and it multiplies index size for a gain nobody here has measured. If a
 * boundary-miss rate shows up in validation, it gets added then, with the number that justified it.
 *
 * PURE AND DETERMINISTIC. No db handle, no clock, no randomness: the same text and budget always
 * produce the same segments, which is what lets the migration be idempotent by protocol (a rerun
 * replaces an observation's segments with an identical set).
 */
import { RELIABLE_EMBED_TOKENS } from "./embed-budget";

/** What a provider must expose for its text to be segmented at all. Structurally satisfied by EmbeddingProvider. */
export interface SegmentBudgetProvider {
  inputWindow?(): number | null | Promise<number | null>;
  countTokens?(text: string): number | Promise<number>;
}

/**
 * The token budget for one segment, or `null` when this provider reads everything it is handed.
 *
 * A provider that declares neither `inputWindow` nor `countTokens` is UNBOUNDED — the honest answer
 * for the lexical provider, which hashes whatever it receives and has no window to overflow. Callers
 * treat null as "do not segment": a guessed budget there would shred text that indexes perfectly, and
 * inventing a number is the same silent-wrongness the window guard exists to remove.
 *
 * A provider that reports a window SMALLER than RELIABLE_EMBED_TOKENS gets its own window, because
 * past it the failure is irreversible data loss rather than degraded ranking.
 */
export async function segmentTokenBudget(provider: SegmentBudgetProvider): Promise<number | null> {
  if (provider.inputWindow === undefined || provider.countTokens === undefined) return null;
  const window = await provider.inputWindow();
  if (window === null) return null; // provider could not determine one — never guess
  return Math.min(RELIABLE_EMBED_TOKENS, window);
}

/**
 * Split on the strongest boundary that fits: paragraph, then sentence, then a hard cut.
 *
 * The hierarchy matters for what a segment MEANS. A paragraph break is the author's own claim
 * boundary and is worth preserving wherever the budget allows; a sentence break still leaves a
 * self-contained assertion; a hard cut leaves neither and exists only so that a single unbroken run
 * of text longer than the budget still gets indexed rather than silently truncated.
 */
const PARAGRAPH = /\n\s*\n+/u;
const SENTENCE = /(?<=[.!?。！？])\s+|\n+/u;

/** Text with its measured token count, so a packing decision never re-counts what it already knows. */
interface Counted {
  text: string;
  tokens: number;
}

async function count(text: string, countTokens: (t: string) => number | Promise<number>): Promise<number> {
  return await countTokens(text);
}

/**
 * Cut one over-budget run of text by TOKENS, not characters.
 *
 * Binary search on the character length rather than a character ratio, because the ratio moves with
 * script — Korean and CJK tokenize far denser than English, so a character budget is a different
 * limit wearing this one's name (the same reasoning that keeps the write guard off string length).
 * Each cut costs O(log n) token counts, paid only by text that has no usable boundary at all.
 */
async function hardCut(
  text: string,
  budget: number,
  countTokens: (t: string) => number | Promise<number>,
): Promise<string[]> {
  const out: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if ((await count(rest, countTokens)) <= budget) { out.push(rest); break; }
    let lo = 1, hi = rest.length, fit = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((await count(rest.slice(0, mid), countTokens)) <= budget) { fit = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    // Prefer a whitespace boundary inside the fitting prefix — a cut mid-word indexes worse than a
    // slightly shorter segment, and the loss is bounded because we only look backwards.
    const slice = rest.slice(0, fit);
    const ws = slice.lastIndexOf(" ");
    const take = ws > fit * 0.6 ? ws : fit;
    out.push(rest.slice(0, take).trim());
    rest = rest.slice(take).trim();
  }
  return out.filter((s) => s.length > 0);
}

/**
 * Segment `text` into units no larger than `budget` tokens.
 *
 * A `null` budget means the provider reads everything: the observation is its own single segment, so
 * a store on the lexical embedder behaves exactly as it does today and this layer costs it nothing.
 *
 * Always returns at least one segment for non-empty input — an observation with no segments would be
 * invisible to retrieval, which is this document's own failure mode reintroduced by its own fix.
 */
export async function segmentObservation(
  text: string,
  budget: number | null,
  provider: SegmentBudgetProvider,
): Promise<string[]> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (budget === null || provider.countTokens === undefined) return [trimmed];
  const countTokens = provider.countTokens.bind(provider);
  if ((await count(trimmed, countTokens)) <= budget) return [trimmed];

  // Break to the finest granularity that any single unit needs, then pack greedily back up. Packing
  // is what keeps a short paragraph from becoming its own thin segment: a segment carries more signal
  // when it is close to the budget than when it is a fragment.
  const units: Counted[] = [];
  for (const para of trimmed.split(PARAGRAPH).map((p) => p.trim()).filter(Boolean)) {
    const paraTokens = await count(para, countTokens);
    if (paraTokens <= budget) { units.push({ text: para, tokens: paraTokens }); continue; }
    for (const sentence of para.split(SENTENCE).map((s) => s.trim()).filter(Boolean)) {
      const sentTokens = await count(sentence, countTokens);
      if (sentTokens <= budget) { units.push({ text: sentence, tokens: sentTokens }); continue; }
      for (const piece of await hardCut(sentence, budget, countTokens)) {
        units.push({ text: piece, tokens: await count(piece, countTokens) });
      }
    }
  }

  const segments: string[] = [];
  let cur = "";
  let curTokens = 0;
  for (const unit of units) {
    if (cur === "") { cur = unit.text; curTokens = unit.tokens; continue; }
    // The joiner COSTS A TOKEN on tokenizers that count it (Codex P2, PR #156). An earlier comment
    // here claimed this over-estimates and never under-estimates; it under-estimated by exactly the
    // separator, so two units summing precisely to the budget were emitted as one segment over it —
    // breaking the one guarantee this function makes. Reserving one token per join is conservative
    // in the safe direction: a segment may end up marginally under budget, never over.
    if (curTokens + unit.tokens + 1 <= budget) { cur = `${cur}\n${unit.text}`; curTokens += unit.tokens + 1; continue; }
    segments.push(cur);
    cur = unit.text;
    curTokens = unit.tokens;
  }
  if (cur !== "") segments.push(cur);
  return segments.length > 0 ? segments : [trimmed];
}
