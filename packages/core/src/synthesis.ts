/**
 * Synthesizer — the Sieve-tier seam (ADR §4.6).
 *
 * This is where the HOST AGENT plugs in. In a real local deployment the coding agent
 * (Stig/claude) implements this — it reads the concept's raw observations and writes
 * back a clean synthesized `body`. There is no bundled generation model and no
 * background worker locally (decision: lazy · agent-only · touch-triggered).
 *
 * Note: synthesis produces ONLY the `body` (the full content). There is deliberately no
 * prose `summary` — a summary reads like an answer and stops agents from fetching
 * (#232). Search advertises a memory via a structural card instead (ADR §4.5).
 *
 * The default `DeterministicSynthesizer` is a no-LLM stand-in for that agent, so the
 * spike can demonstrate the *flow* (store marks dirty → touch synthesizes) end to end.
 */
export interface Synthesizer {
  /** May be sync (deterministic stand-in) or async (a real host-agent call). Engine awaits it. */
  synthesize(
    observations: string[],
    current: { body: string } | null,
  ): { body: string } | Promise<{ body: string }>;
}

export class DeterministicSynthesizer implements Synthesizer {
  synthesize(observations: string[]): { body: string } {
    // Dedupe evidence, preserve order. (A real agent would write a coherent narrative.)
    const seen = new Set<string>();
    const distinct: string[] = [];
    for (const o of observations) {
      const t = o.trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        distinct.push(t);
      }
    }
    return { body: distinct.join("\n") };
  }
}
