/**
 * Real-store md-tree exporter — Phase 1 corpus derivation, content-export sibling of
 * md-export.ts's exportMdTree().
 *
 * WHY A SEPARATE FUNCTION RATHER THAN EXTENDING exportMdTree(): exportMdTree()'s signature
 * (ExportOpts = { circle, keyMap, scenario }) exists ENTIRELY to carry synthetic gold ground
 * truth (Scenario.seed[].key → conceptId) through to a chunkId→conceptKey manifest for scoring
 * against KNOWN gold in the synthetic scenario suite (spec §2.2). A real store was never seeded
 * via seedScenario()/Scenario.seed[].key — there is no key→conceptId map and no synthetic gold to
 * carry through, so keyMap/scenario are genuinely N/A here, not merely optional. Fabricating a
 * fake Scenario/keyMap just to satisfy the existing signature would be dishonest scaffolding for
 * a concept (gold-manifest machinery) that doesn't apply to this input — the mission's explicit
 * instruction is "add a new, real-store-oriented export function... that reuses the
 * clustering/chunking helpers but has a signature that doesn't require scenario/gold," which is
 * exactly what this module does.
 *
 * REUSE, NOT REIMPLEMENTATION: every piece of clustering/chunking logic below is the SAME
 * function imported from md-export.ts (coOccurredClusters, sectionsForMembers, chunkTopicFile,
 * slugify, oneLineSummary) — exported from that module for this purpose, not duplicated. In
 * particular this reuses the CONSTRUCT-TIME section derivation exactly as implemented
 * (sectionsForMembers builds `{ text: "## ${title}\n\n${body}", conceptId }` directly from
 * concept objects) and NEVER reintroduces re-parsing an already-built file body to find section
 * boundaries — md-export.ts's module doc explains at length why that re-parse approach was a
 * fixed bug class (the A5 fix, "wrong-occurrence mis-split" trap). This module inherits that fix
 * for free by calling the same functions, not by re-deriving similar logic independently.
 *
 * OUTPUT SHAPE (mirrors exportMdTree's three-artifact shape, minus the manifest):
 *   indexMd     — same "# Memory index" + per-cluster heading + one-line-per-concept shape.
 *   topicFiles  — relative path → file content, one file per co_occurred cluster.
 *   chunks      — { chunkId, file, text }[], construct-time derived, NO gold mapping attached
 *                 (there is no gold for a real store — the OTHER actor's eval-scoring machinery,
 *                 built separately and walled off from this work, is responsible for whatever it
 *                 needs to do with these chunks; this module's job stops at producing them).
 */
import type { MonetCore } from "../engine";
import { coOccurredClusters, sectionsForMembers, chunkTopicFile, slugify, oneLineSummary, type ExportedChunk } from "./md-export";
// P1-b fix (round 2 review, "Scrub generated topic filenames"): scrubString imported from the
// shared src/eval/scrub-patterns.mjs module (see that module's doc comment for the full rationale
// — in short: scrubbing an ALREADY-SLUGIFIED filename can't reliably detect a tilde-path or email
// that slugify() has already collapsed into indistinguishable-from-ordinary-prose hyphens, so the
// fix must scrub the TITLE before slugify() ever runs, while the original separators are intact).
import { scrubString } from "./scrub-patterns.mjs";

export interface StoreExportOpts {
  circle: string;
}

export interface StoreExportResult {
  indexMd: string;
  /** relative topic-file path → file content. */
  topicFiles: Map<string, string>;
  chunks: ExportedChunk[];
  /** Same self-integrity signal as exportMdTree's collidedSlugs — see md-export.ts's doc comment for why a non-empty list isn't itself a defect. */
  collidedSlugs: string[];
}

/**
 * Export a real (non-scenario-seeded) MonetCore's circle into a steelman md-tree: index.md +
 * clustered topic files + chunk metadata. Pure read: allConceptsForExport() + edges(), no
 * synthesis/usefulness side effects — identical non-mutating contract to exportMdTree().
 */
export function exportMdTreeFromStore(core: MonetCore, opts: StoreExportOpts): StoreExportResult {
  const { circle } = opts;
  const concepts = core.allConceptsForExport(circle);
  const conceptById = new Map(concepts.map((c) => [c.id, c]));
  const allIds = concepts.map((c) => c.id).sort();

  const clusters = coOccurredClusters(core, circle, allIds);

  // Identical disambiguation logic to exportMdTree (F1 fix, see md-export.ts doc comment): a
  // slugify() truncation collision between two different clusters' lead titles must not silently
  // overwrite one cluster's topic file. Same fix, same reasoning, applied here.
  const usedSlugs = new Set<string>();
  const collidedSlugs: string[] = [];

  const topicFiles = new Map<string, string>();
  const chunks: ExportedChunk[] = [];
  const indexByCluster: Array<{ heading: string; lines: string[] }> = [];

  for (const cluster of clusters) {
    const members = cluster.map((id) => conceptById.get(id)!).filter(Boolean);
    if (members.length === 0) continue;
    const lead = members[0];
    // P1-b fix: slugify() runs on the SCRUBBED title, not the raw one — see this file's import
    // comment above. Only the slug-derivation input changes here; `lead.title` itself (used below
    // for fileBody/indexMd headings) stays raw, since that text still goes through
    // scrub-corpus.mjs's own content-scrub pass downstream like every other body/title string —
    // this fix is narrowly scoped to the one place slugify() output becomes a PUBLISHED FILENAME
    // that content-scrubbing alone can never reach.
    const clusterSlug = slugify(scrubString(lead.title));
    const isCollision = usedSlugs.has(clusterSlug);
    const relPath = isCollision ? `topics/${clusterSlug}--${lead.id}.md` : `topics/${clusterSlug}.md`;
    if (isCollision) collidedSlugs.push(clusterSlug);
    usedSlugs.add(clusterSlug);

    // Construct-time sections, shared by both fileBody and the chunker (A5 fix — see
    // md-export.ts's extensive comment on why this is never re-derived by re-parsing fileBody).
    const sections = sectionsForMembers(members);
    const fileBody = [`# ${lead.title}`, ...sections.map((s) => s.text)].join("\n\n").trim() + "\n";
    const clusterIndexLines = members.map((m) => `- [${m.title}](${relPath}) — ${oneLineSummary(m.body)} (${m.kind})`);
    topicFiles.set(relPath, fileBody);
    indexByCluster.push({ heading: lead.title, lines: clusterIndexLines });

    const fileChunks = chunkTopicFile(fileBody.replace(/^# .*\n\n/, ""), sections);
    fileChunks.forEach(({ text }, i) => {
      const chunkId = `${relPath}#${i}`;
      chunks.push({ chunkId, file: relPath, text });
    });
  }

  const indexMd = [
    `# Memory index`,
    "",
    `${concepts.length} concepts across ${clusters.length} topic${clusters.length === 1 ? "" : "s"}.`,
    "",
    ...indexByCluster.flatMap(({ heading, lines }) => [`## ${heading}`, "", ...lines, ""]),
  ].join("\n");

  return { indexMd, topicFiles, chunks, collidedSlugs };
}
