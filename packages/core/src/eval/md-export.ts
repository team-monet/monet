/**
 * md-tree exporter — Phase 0(a)/(b) of the engine-vs-md proof harness (spec §2.1, §2.2).
 *
 * Takes a seeded MonetCore (the same seedScenario() path harness.ts uses for the three
 * engine arms) and emits a STEELMAN md-tree: what a competent human would hand-write as a
 * claude.md/AGENTS.md-style memory tree for this corpus. Two things this is NOT:
 *   - not an agent-maintained variant (that needs an agent-in-the-loop harness — Phase 1 only,
 *     per spec §2.1's "second variant" note),
 *   - not a raw JSON dump of concepts (the steelman requirement is prose, like a human wrote it).
 *
 * OUTPUT SHAPE (three artifacts, written under a caller-supplied root dir):
 *   index.md                  — one line per concept: title · one-line summary · kind · path,
 *                                grouped by topic cluster. Modeled on Claude Code's auto-memory
 *                                MEMORY.md index (an index file with per-topic links + a
 *                                one-line description each), crossed with a human index-map
 *                                convention (grouped, not flat).
 *   topics/<cluster-id>.md    — one file per cluster; full concept bodies, written as prose,
 *                                grouped under `##` headers (one header per concept) so the
 *                                chunker (below) has real header boundaries to split on.
 *   md-export-manifest.json   — chunkId → conceptKey, carried MECHANICALLY from
 *                                Scenario.seed[].key at export time (no subjective mapping —
 *                                per spec §2.2, this is the same ground truth the scenario
 *                                authors already have).
 *
 * CLUSTERING — grouping heuristic ONLY, never a retrieval mechanism (spec §2.1 is explicit
 * about this boundary): co_occurred connected components over core.edges(), a "worked together" signal used here purely to decide which
 * concepts land in the same topic file. A concept with no co_occurred edges (every
 * single-fact scenario — gotchas/decisions/preferences seeded alone in their own session, per
 * scenarios.ts's own comment on why those carry no tangents) becomes its own singleton
 * cluster. This is the simplest honest clustering, not a claim that co_occurred is optimal
 * for md organization — flagged per the mission's "implement the simplest honest version"
 * instruction rather than gold-plating cluster-quality heuristics.
 *
 * IDENTITY IS DERIVED FROM CONCEPT IDS, NOT TITLE STRINGS (post-review fix, both an
 * empirically-constructed cold-audit finding and a briefed-review finding converged here):
 * `Concept.title` is lossy (truncated ~78 chars, per title-derivation.test.ts) and is NOT
 * guaranteed unique across concepts — using it as an identity key for chunkId/relPath
 * construction OR for gold-mapping (title string equality) both silently corrupt on a
 * collision (dropped topic file, duplicate chunkIds, wrong gold mapping) rather than failing
 * loudly. Every identity-bearing construction below (relPath disambiguation, chunkId, gold
 * mapping) is keyed on concept.id, which the engine guarantees unique. Titles are used ONLY
 * for human-readable display (headers, index lines, slugs) — never as a lookup key.
 */
import type { MonetCore } from "../engine";
import type { Scenario } from "./scenarios";

export interface ExportedChunk {
  /**
   * Globally unique within one export by construction: derived from the (disambiguated,
   * therefore unique) relPath plus a per-file chunk index — `${relPath}#${n}`. Never derived
   * from a title/slug alone, which is not guaranteed unique (see module-level note above).
   */
  chunkId: string;
  /** Relative path (from the export root) to the topic file this chunk came from. */
  file: string;
  text: string;
}

export interface MdExportManifest {
  /** chunkId → the scenario seed `key` of the concept whose gold content lives in this chunk. */
  chunkIdToConceptKey: Record<string, string>;
}

export interface MdExportResult {
  indexMd: string;
  /** relative topic-file path → file content. */
  topicFiles: Map<string, string>;
  chunks: ExportedChunk[];
  manifest: MdExportManifest;
  /**
   * Self-integrity signal (mirrors harness.ts's auditScenarios philosophy): any of the
   * scenario's OWN seed keys that never ended up as a manifest value — i.e. a gold concept
   * whose chunk could not be mechanically identified (see chunkTopicFile's paragraph-fallback
   * path, which degrades to "no gold key" only in the genuinely pathological case where there
   * are no members at all to derive sections from, per the A5 fix). Should be empty for the
   * current corpus — a non-empty list is a real defect to investigate, not a rare edge case to
   * silently tolerate.
   */
  unmappedGoldKeys: string[];
  /**
   * Self-integrity signal (post-review addition, alongside unmappedGoldKeys): topic slugs
   * that collided across two or more DIFFERENT clusters (same first-48-chars-after-slugify
   * prefix from different lead concepts) and were disambiguated via a stable concept-id
   * suffix on relPath. Empty in the common case. A non-empty list is not itself a defect —
   * disambiguation handles it correctly — but it's surfaced so a real collision is visible in
   * reports/CI output rather than silently invisible, since it's exactly the kind of thing
   * that's latent on a small corpus and activates on Phase 1's corpus-growth path.
   */
  collidedSlugs: string[];
}

// ── Clustering: co_occurred connected components over the PUBLIC edges() surface ──────────
// (Not core-internal reuse of engine.ts's private topThread() union-find — that method only
// returns the single LARGEST component and has private-field access this eval code doesn't
// have. Same algorithm, applied here to get ALL components via the public API.)

export function coOccurredClusters(core: MonetCore, circle: string, allIds: string[]): string[][] {
  const edges = core.edges({ circle, type: "co_occurred" });
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const e of edges) {
    link(e.srcId, e.dstId);
    link(e.dstId, e.srcId);
  }
  const idSet = new Set(allIds);
  const seen = new Set<string>();
  const clusters: string[][] = [];
  for (const id of allIds) {
    if (seen.has(id)) continue;
    const comp: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const nb of adj.get(cur) ?? []) if (idSet.has(nb) && !seen.has(nb)) (seen.add(nb), stack.push(nb));
    }
    clusters.push(comp.sort());
  }
  return clusters;
}

// ── Cluster naming / topic labeling ────────────────────────────────────────────────────────

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "topic"
  );
}

/**
 * One-line summary: first sentence (or first ~120 chars) of the body — a human index blurb, not
 * the full claim.
 *
 * F1 fix (post-review, confirmed in shipped artifacts — e.g. eval-corpus/publish/100/index.md):
 * the prior regex `/^[^.!?]*[.!?]/` excluded `.!?` from the character class but NOT `\n`, so a
 * body whose first sentence spans a newline (a heading/list-prefixed body, e.g. "## Section\n\n###
 * 1.") matched through the newline and produced a "one-line" summary that wasn't one line — it
 * embedded a literal `\n`, which splits the index.md bullet it's interpolated into across two
 * malformed markdown lines. Excluding `\n` from the class (`[^.!?\n]`) stops the match at the first
 * line break. That alone isn't sufficient, though: the `candidate = body` (verbatim) fallback branch
 * — taken whenever there's no `.!?` within 160 chars, or the first "sentence" is longer than that —
 * can ALSO carry newlines (a body with no early punctuation but an early line break), so both
 * branches are passed through a whitespace-collapse before the final length/truncation step.
 * Verified empirically against the real corpus (eval-corpus/source/monet.db): exactly 4 concepts'
 * bodies triggered the bug under the old regex.
 */
export function oneLineSummary(body: string): string {
  const firstSentence = body.match(/^[^.!?\n]*[.!?]/)?.[0]?.trim();
  const candidate = firstSentence && firstSentence.length <= 160 ? firstSentence : body;
  const collapsed = candidate.replace(/\s+/g, " ").trim();
  return collapsed.length > 140 ? collapsed.slice(0, 137).trimEnd() + "…" : collapsed;
}

// ── Header-boundary chunker with paragraph fallback (spec §2.2) ───────────────────────────

const PARAGRAPH_CHUNK_TARGET_TOKENS = 300; // midpoint of the spec's ~200-400 token fallback band
const APPROX_CHARS_PER_TOKEN = 4; // standard rough English approximation, used only for the fallback chunk boundary

export interface ChunkedSegment {
  text: string;
  /**
   * The concept this chunk's content came from, when mechanically known — null when it isn't
   * (the paragraph-fallback path, where a chunk can span multiple concepts' text or none, so
   * no single concept id can be honestly attributed). NEVER re-derived from title-string
   * matching after the fact (the F2 fix): the header-split path below tracks conceptId
   * directly from the member that produced each `##` section, at construction time.
   */
  conceptId: string | null;
}

/**
 * A5 fix (adversarial-verification finding): CONSTRUCT-TIME chunk derivation, REPLACING the
 * A4-era approach of RE-PARSING the already-built fileBody via positional string search
 * (splitByMemberHeadings, deleted by this fix — see below for why it isn't kept even as a
 * self-check).
 *
 * A4 made that search robust to a member's OWN body containing an internal `## ` line, and to
 * duplicate titles within one cluster, by always searching forward from the previous member's
 * found position. But A4 left one class of trap unguarded: if member A's BODY contains the
 * literal line `## <B's exact title>` BEFORE B's real heading is written, the forward search
 * for B's heading matches A's body-embedded occurrence FIRST — it is textually earlier than
 * B's real heading, and "search forward from the cursor" finds the nearest match, not the
 * right one. The result is a SILENT wrong-occurrence mis-split: A's chunk is truncated (real
 * content lost), B's chunk is contaminated with content that was actually A's. No existing
 * integrity signal catches this — `allMembersFound` stays true (a heading WAS found, just the
 * wrong occurrence of it) and `unmappedGoldKeys` stays empty (every chunk still gets SOME gold
 * mapping, just a wrong-boundaried one). Only the missing-occurrence case was ever guarded;
 * the wrong-occurrence case was not, because search-based reconstruction can't distinguish
 * "the real heading" from "a line that looks exactly like the real heading" — both are the
 * same string to indexOf.
 *
 * The fix is a simplification, not a smarter search: the exporter already HAS each member's
 * section string in hand at the moment it builds the file (the loop in exportMdTree below),
 * so there is never a need to reconstruct section boundaries by searching the joined text
 * afterward. `sectionsForMembers` builds the `{ conceptId, text }` array directly from
 * `members`, in order, with each section's text set to exactly `## ${m.title}\n\n${m.body}`
 * (trimmed) — the same string the old positional split produced ON NON-PATHOLOGICAL INPUT,
 * but now impossible to mis-attribute BY CONSTRUCTION: there is no search, so there is no
 * "wrong occurrence" for a search to find. A trap heading embedded in an earlier member's body
 * is just inert text inside that member's own section; it can never be mistaken for a
 * different member's boundary because boundaries are never derived from body content at all.
 *
 * WHY splitByMemberHeadings ISN'T KEPT AS A SELF-CHECK EITHER (considered and rejected, not an
 * oversight): an early version of this fix kept the positional search alive purely to compare
 * its output against `sectionsForMembers` and flag any disagreement. That self-check turned out
 * to be actively misleading: on exactly the trap-heading input this fix targets, the search
 * necessarily reconstructs the WRONG boundaries (that's the defect) — so the self-check would
 * "correctly" fire a mismatch every time the fix is doing its job, and stay silent otherwise.
 * That inverts the useful/silent relationship every other integrity signal in this file follows
 * (unmappedGoldKeys/collidedSlugs fire on real defects and stay silent when things are healthy).
 * A signal that fires when the code is CORRECT and stays silent when it would have been WRONG is
 * worse than no signal — it invites exactly the wrong triage. Deleting the search machinery
 * outright removes both the correctness risk (no search means no wrong-occurrence class to guard
 * against — proven, not just argued, by src/__tests__/eval-baseline.test.ts's A5 trap/cascade
 * regressions) and the maintenance liability of a signal whose "healthy" state looks like a
 * failure.
 */
export function sectionsForMembers(members: Array<{ id: string; title: string; body: string; kind: string }>): ChunkedSegment[] {
  return members.map((m) => ({ text: `## ${m.title}\n\n${m.body}`.trim(), conceptId: m.id }));
}

/**
 * Fixed-size (~200-400 token) paragraph chunker for genuinely header-less input — conceptId is
 * always null (a paragraph chunk may span multiple concepts or none, and guessing via title
 * matching is exactly the fragility the A4/A5 fixes remove). Unchanged in spirit from the A4
 * version; only reached now when `members` is empty (no sections to derive at all), since
 * construct-time derivation always succeeds whenever there's at least one member.
 */
function paragraphFallback(fileBody: string): ChunkedSegment[] {
  const paragraphs = fileBody.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const targetChars = PARAGRAPH_CHUNK_TARGET_TOKENS * APPROX_CHARS_PER_TOKEN;
  const chunks: string[] = [];
  let cur = "";
  for (const p of paragraphs) {
    if (cur && cur.length + p.length > targetChars) {
      chunks.push(cur.trim());
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  const result = chunks.length > 0 ? chunks : [fileBody.trim()];
  return result.map((text) => ({ text, conceptId: null }));
}

/**
 * Chunk a topic file, CONSTRUCT-TIME (A5 fix): `sections` is the caller's own already-built
 * sections array (from `sectionsForMembers`, computed once in exportMdTree so fileBody and
 * chunks share one source) — returned as-is, never re-derived by re-parsing `fileBody`. Falls
 * back to fixed-size paragraph chunks (over `fileBody`) only when there are no members at all,
 * the one genuinely header-less case (nothing to derive sections from).
 */
export function chunkTopicFile(fileBody: string, sections: ChunkedSegment[]): ChunkedSegment[] {
  return sections.length > 0 ? sections : paragraphFallback(fileBody);
}

// ── Main export ─────────────────────────────────────────────────────────────────────────────

export interface ExportOpts {
  circle: string;
  /** key→conceptId map from seedScenario(), so gold can be carried mechanically (spec §2.2). */
  keyMap: Map<string, string>;
  /** The scenario being exported, for its seed[].key gold ground truth. */
  scenario: Scenario;
}

/**
 * Export a seeded MonetCore into a steelman md-tree. Pure function of the core's current
 * concept store (read-only: uses allConceptsForExport + edges(), no synthesis/usefulness
 * side effects) plus the scenario's own key→conceptId seeding map.
 */
export function exportMdTree(core: MonetCore, opts: ExportOpts): MdExportResult {
  const { circle, keyMap, scenario } = opts;
  const concepts = core.allConceptsForExport(circle);
  const conceptById = new Map(concepts.map((c) => [c.id, c]));
  const allIds = concepts.map((c) => c.id).sort();

  // Invert keyMap (conceptId → key) so a chunk's mechanical gold-key lookup is O(1). A dedup
  // merge (#239) COULD in principle collapse two seed keys onto one concept id; scenarios.ts's
  // own comment documents this as a real (if rare) possibility. Last-key-wins here mirrors
  // Map.set's natural iteration-order semantics and is flagged, not silently masked — it's the
  // same ambiguity the engine itself accepts when two keys merge into one concept.
  const conceptIdToKey = new Map<string, string>();
  for (const [key, id] of keyMap) conceptIdToKey.set(id, key);

  const clusters = coOccurredClusters(core, circle, allIds);

  // Cluster topic label = lead member's title (highest-support / lexicographic tie-break
  // would need support_count, which allConceptsForExport doesn't carry — so: first member by
  // sorted id, a deterministic and simple choice consistent with "simplest honest version").
  //
  // relPath UNIQUENESS (F1 fix): slugify() truncates to 48 chars, so two DIFFERENT clusters'
  // lead titles can slugify to the SAME string — a cross-cluster collision. Left unguarded,
  // topicFiles.set(relPath) would silently overwrite the first cluster's entire topic file,
  // and every chunkId/relPath downstream would collide too (duplicate chunkIds corrupt the
  // BM25 index — a later tf.set(id) drops the earlier chunk's text — and corrupt gold-mapping
  // lookups, per harness-baseline.ts's chunkId-keyed manifest reads). usedSlugs tracks every
  // slug already claimed THIS export; first use keeps the clean `topics/<slug>.md` name
  // (unchanged from before this fix, in the common non-colliding case); a repeat use appends
  // a STABLE, content-derived suffix (the lead concept's id — never an opaque counter, so the
  // disambiguated name is reproducible and traceable back to which concept caused it) rather
  // than silently overwriting.
  const usedSlugs = new Set<string>();
  const collidedSlugs: string[] = [];

  const topicFiles = new Map<string, string>();
  const chunks: ExportedChunk[] = [];
  const chunkIdToConceptKey: Record<string, string> = {};
  const indexLines: string[] = [];
  const indexByCluster: Array<{ heading: string; lines: string[] }> = [];

  for (const cluster of clusters) {
    const members = cluster.map((id) => conceptById.get(id)!).filter(Boolean);
    if (members.length === 0) continue;
    const lead = members[0];
    const clusterSlug = slugify(lead.title);
    const isCollision = usedSlugs.has(clusterSlug);
    const relPath = isCollision ? `topics/${clusterSlug}--${lead.id}.md` : `topics/${clusterSlug}.md`;
    if (isCollision) collidedSlugs.push(clusterSlug);
    usedSlugs.add(clusterSlug);

    // A5 fix: sections are built ONCE, here, directly from `members` — the same source both
    // fileBody and chunks derive from (chunks by construction, not by re-parsing fileBody at
    // all). fileBody is a plain join of `# ${lead.title}` plus every section, exactly
    // reproducing the prior concatenation's bytes on non-pathological input (verified via the
    // eval:baseline byte-identical run, not just asserted).
    const sections = sectionsForMembers(members);
    const fileBody = [`# ${lead.title}`, ...sections.map((s) => s.text)].join("\n\n").trim() + "\n";
    const clusterIndexLines = members.map((m) => `- [${m.title}](${relPath}) — ${oneLineSummary(m.body)} (${m.kind})`);
    topicFiles.set(relPath, fileBody);
    indexByCluster.push({ heading: lead.title, lines: clusterIndexLines });
    indexLines.push(...clusterIndexLines);

    // Chunk this topic file CONSTRUCT-TIME (A5 fix): chunkTopicFile returns the SAME `sections`
    // array built above, unchanged — never re-derived by searching fileBody — so the
    // wrong-occurrence mis-split (a trap `## <title>` line inside an earlier member's body
    // matching before the real heading) is impossible by construction, not merely guarded
    // against. `fileBody` is passed through only for the header-less paragraph-fallback path,
    // which this branch never hits (sections is always non-empty here — members.length > 0 was
    // already checked above).
    const fileChunks = chunkTopicFile(fileBody.replace(/^# .*\n\n/, ""), sections); // drop the file-level title line, kept for fallback-path symmetry
    fileChunks.forEach(({ text, conceptId }, i) => {
      // chunkId derived from the now-uniquely-disambiguated relPath, not from clusterSlug
      // directly (F1 fix) — relPath uniqueness is the single source of truth chunkId inherits
      // from, so there is exactly one place collisions are prevented, not two to keep in sync.
      const chunkId = `${relPath}#${i}`;
      chunks.push({ chunkId, file: relPath, text });
      if (conceptId) {
        const key = conceptIdToKey.get(conceptId);
        if (key) chunkIdToConceptKey[chunkId] = key;
      }
    });
  }

  const indexMd = [
    `# Memory index`,
    "",
    `${concepts.length} concepts across ${clusters.length} topic${clusters.length === 1 ? "" : "s"}.`,
    "",
    ...indexByCluster.flatMap(({ heading, lines }) => [`## ${heading}`, "", ...lines, ""]),
  ].join("\n");

  const mappedKeys = new Set(Object.values(chunkIdToConceptKey));
  const unmappedGoldKeys = scenario.seed.map((s) => s.key).filter((key) => !mappedKeys.has(key));

  return { indexMd, topicFiles, chunks, manifest: { chunkIdToConceptKey }, unmappedGoldKeys, collidedSlugs };
}
