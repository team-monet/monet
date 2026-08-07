/**
 * THE COUNT AND THE GATE MUST AGREE.
 *
 * A store's pin is one-way for content. Once it moves to a Latin-only checkpoint, rows in another
 * script keep their text and lose their vectors permanently — and measurement showed the damage is
 * not confined to them: on bge-small-en-v1.5 unrelated Korean rows scored 0.42-0.52 against English
 * queries and took a quarter of the top-5 slots, above the 0.35 emission floor, while never being
 * retrievable by their own content.
 *
 * So `doctor` reports what a Latin-only pin would strand, and it has to answer with the SAME
 * measurement the write gate enforces. Two independent readings of "is this row Latin enough" is the
 * drift this file exists to prevent: a diagnostic that clears a row the write path refuses tells an
 * operator to proceed into exactly the irreversible loss it was added to prevent.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore, nonLatinLetterShare, NON_LATIN_LETTER_TOLERANCE, ContentScriptUnsupportedError } from "../engine";
import { inspectStoredEmbedderState } from "../diagnostics";
import { HashingEmbeddingProvider, type EmbeddingProvider } from "../embedding";

const dirs: string[] = [];
const freshDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "monet-non-latin-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Lexical provider that also claims the Latin-only restriction, so the write gate engages. */
class LatinOnlyProvider extends HashingEmbeddingProvider {
  readonly readsOnlyLatinScript = true;
}

const KOREAN = "게더를 제거하고 검색만 남기기로 했다. 오늘 측정이 그 결정을 뒷받침한다.";
const ENGLISH = "we removed gather and kept search only; today's measurement supports that decision";
const MOSTLY_ENGLISH = "the segment budget is 380 tokens — the Korean note said 예산 as shorthand";

describe("nonLatinLetterShare", () => {
  it("is 0 for text with no letters at all — digits and punctuation are not evidence", () => {
    expect(nonLatinLetterShare("380 — 0.35 (1.5.0)")).toBe(0);
    expect(nonLatinLetterShare("")).toBe(0);
  });

  it("scores by LETTERS, so a mostly-English line with a foreign word stays under tolerance", () => {
    expect(nonLatinLetterShare(ENGLISH)).toBe(0);
    expect(nonLatinLetterShare(MOSTLY_ENGLISH)).toBeLessThanOrEqual(NON_LATIN_LETTER_TOLERANCE);
    expect(nonLatinLetterShare(KOREAN)).toBeGreaterThan(NON_LATIN_LETTER_TOLERANCE);
  });
});

describe("doctor's non-Latin count", () => {
  const seed = async (embedder: EmbeddingProvider, texts: string[]): Promise<string> => {
    const dir = freshDir();
    const path = join(dir, "monet.db");
    const core = new MonetCore(path, { embedder });
    await core.ensureEmbedderPin();
    for (const t of texts) await core.store(t);
    core.close();
    return path;
  };

  it("counts exactly the rows the write gate would refuse, and names a sample", async () => {
    // Seeded through a provider WITHOUT the restriction, which is the real situation: the rows are
    // already there, written under a multilingual pin, and the question is what a move would cost.
    const path = await seed(new HashingEmbeddingProvider(), [KOREAN, ENGLISH, MOSTLY_ENGLISH]);

    const inspection = inspectStoredEmbedderState(path);
    expect(inspection.nonLatin.status).toBe("known");
    if (inspection.nonLatin.status !== "known") return;
    expect(inspection.nonLatin.tolerance).toBe(NON_LATIN_LETTER_TOLERANCE);
    expect(inspection.nonLatin.observationCount).toBe(1);
    // The concept BODY derived from that observation is Korean too, and the migration re-embeds it
    // separately — so it is a second offender, reported in its own population rather than summed.
    expect(inspection.nonLatin.conceptCount).toBe(1);
    expect(inspection.nonLatin.sampleIds).toHaveLength(2);
  });

  it("REPORTS ON A MULTILINGUAL PIN — the count is worthless once the pin has already moved", async () => {
    const path = await seed(new HashingEmbeddingProvider(), [KOREAN]);
    const inspection = inspectStoredEmbedderState(path);
    // The seeding provider declares no restriction, and the count is still produced.
    expect(inspection.nonLatin.status).toBe("known");
    if (inspection.nonLatin.status !== "known") return;
    expect(inspection.nonLatin.observationCount).toBe(1);
  });

  it("agrees with the write gate row for row", async () => {
    const dir = freshDir();
    const path = join(dir, "monet.db");
    const permissive = new MonetCore(path, { embedder: new HashingEmbeddingProvider() });
    await permissive.ensureEmbedderPin();
    for (const t of [KOREAN, ENGLISH, MOSTLY_ENGLISH]) await permissive.store(t);
    permissive.close();

    const counted = inspectStoredEmbedderState(path).nonLatin;
    expect(counted.status).toBe("known");
    if (counted.status !== "known") return;

    // Now ask the GATE about the same three texts and count its refusals independently.
    const strictDir = freshDir();
    const strict = new MonetCore(join(strictDir, "monet.db"), { embedder: new LatinOnlyProvider() });
    let refused = 0;
    for (const t of [KOREAN, ENGLISH, MOSTLY_ENGLISH]) {
      try {
        strict.assertEmbedderReadsScript(t);
      } catch (error) {
        expect(error).toBeInstanceOf(ContentScriptUnsupportedError);
        refused++;
      }
    }
    strict.close();

    expect(counted.observationCount).toBe(refused);
  });

  it("returns zero for an all-Latin store rather than omitting the field", async () => {
    const path = await seed(new HashingEmbeddingProvider(), [ENGLISH, MOSTLY_ENGLISH]);
    const inspection = inspectStoredEmbedderState(path);
    expect(inspection.nonLatin.status).toBe("known");
    if (inspection.nonLatin.status !== "known") return;
    expect(inspection.nonLatin.observationCount).toBe(0);
    expect(inspection.nonLatin.sampleIds).toEqual([]);
  });

  it("counts SOURCE observations too — the migration re-embeds them and search compares them", async () => {
    // enforcedSourceObservationRows is a second selector migrateEmbeddings drives, and
    // scoreSourceConcepts compares those vectors against live queries. A scan that filtered on
    // kind != 'source' reported zero while the rewrite made source recall meaningless
    // (Codex P1, PR #173).
    const dir = freshDir();
    const path = join(dir, "monet.db");
    const core = new MonetCore(path, { embedder: new HashingEmbeddingProvider() });
    await core.ensureEmbedderPin();
    await core.store(ENGLISH);
    const db = (core as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db;
    db.prepare(
      `INSERT INTO observations (id, concept_id, content, kind, embedding, created_at, author_agent_id)
       VALUES (?, NULL, ?, 'source', '[]', 1, 'test')`,
    ).run("src-korean-1", KOREAN);
    core.close();

    const n = inspectStoredEmbedderState(path).nonLatin;
    expect(n.status).toBe("known");
    if (n.status !== "known") return;
    expect(n.observationCount).toBe(1);
    expect(n.sampleIds).toContain("src-korean-1");
  });

  it("counts SUPERSEDED native rows — the migration rewrites those as well", async () => {
    // enforcedNativeObservationRows has NO supersession filter. A scan that added one under-counted
    // exactly the rows the rewrite still touches.
    const dir = freshDir();
    const path = join(dir, "monet.db");
    const core = new MonetCore(path, { embedder: new HashingEmbeddingProvider() });
    await core.ensureEmbedderPin();
    const stored = await core.store(KOREAN);
    const db = (core as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db;
    db.prepare(`UPDATE observations SET superseded_at = 1 WHERE concept_id = ?`).run(stored.conceptId);
    core.close();

    const n = inspectStoredEmbedderState(path).nonLatin;
    expect(n.status).toBe("known");
    if (n.status !== "known") return;
    expect(n.observationCount).toBeGreaterThan(0);
  });

  it("counts source rows in a store that predates source_chunks — SourceLedger creates it on open, and the migration then takes them", async () => {
    const dir = freshDir();
    const path = join(dir, "monet.db");
    const core = new MonetCore(path, { embedder: new HashingEmbeddingProvider() });
    await core.ensureEmbedderPin();
    await core.store(ENGLISH);
    const db = (core as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db;
    db.prepare(
      `INSERT INTO observations (id, concept_id, content, kind, embedding, created_at, author_agent_id)
       VALUES (?, NULL, ?, 'source', '[]', 1, 'test')`,
    ).run("legacy-src-1", KOREAN);
    db.prepare(`DROP TABLE IF EXISTS source_chunks`).run();
    core.close();

    const n = inspectStoredEmbedderState(path).nonLatin;
    expect(n.status).toBe("known");
    if (n.status !== "known") return;
    expect(n.sampleIds).toContain("legacy-src-1");
  });

  it("counts a non-Latin CONCEPT BODY even when every observation is English — applySynthesis has no script gate", async () => {
    // The one population that can be non-Latin in an all-English store. migrateEmbeddings' concept
    // phase re-embeds the body and rebuilds `related` edges from that vector, so a diagnostic that
    // certified "nothing affected" would have been wrong in a way that corrupts the graph, not just
    // recall (Codex P1, PR #173).
    const dir = freshDir();
    const path = join(dir, "monet.db");
    const core = new MonetCore(path, { embedder: new HashingEmbeddingProvider() });
    await core.ensureEmbedderPin();
    const stored = await core.store(ENGLISH);
    await core.applySynthesis(stored.conceptId, KOREAN);
    core.close();

    const n = inspectStoredEmbedderState(path).nonLatin;
    expect(n.status).toBe("known");
    if (n.status !== "known") return;
    expect(n.observationCount).toBe(0); // every observation is English
    expect(n.conceptCount).toBe(1);      // the synthesized body is not
    expect(n.sampleIds).toContain(stored.conceptId);
  });

  it("always names a CONCEPT BODY sample, even when observations already filled the sample budget", async () => {
    // The regression a shared first-come buffer causes: plenty of non-English observations crowd
    // out every body id, and the operator is told bodies exist with nothing to look at.
    const dir = freshDir();
    const path = join(dir, "monet.db");
    const core = new MonetCore(path, { embedder: new HashingEmbeddingProvider() });
    await core.ensureEmbedderPin();
    for (let i = 0; i < 6; i++) await core.store(`${KOREAN} 사례 ${i}`);
    const english = await core.store(ENGLISH);
    await core.applySynthesis(english.conceptId, KOREAN);
    core.close();

    const n = inspectStoredEmbedderState(path).nonLatin;
    expect(n.status).toBe("known");
    if (n.status !== "known") return;
    expect(n.observationCount).toBeGreaterThanOrEqual(6);
    expect(n.conceptCount).toBeGreaterThan(0);
    expect(n.sampleIds).toContain(english.conceptId);
  });
});
