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
import { inspectNonLatinContent, inspectStoredEmbedderState } from "../diagnostics";
import { HashingEmbeddingProvider, type EmbeddingProvider } from "../embedding";
import { BetterSqlitePort } from "../storage";

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

  it("scans PAST ONE PAGE — the keyset cursor has to advance, or a big store reports a partial count", async () => {
    /*
     * The scan reads in id-ordered pages of 500 rather than streaming, so that it can run through a
     * StoragePort (#14). A cursor that fails to advance loops forever and one that advances wrongly
     * silently truncates the count — and a fixture under one page can exhibit NEITHER. This seeds
     * 600 rows by raw INSERT (core.store() would be far slower and adds resolution work that has
     * nothing to do with paging) with ids chosen so lexical id order interleaves the two scripts,
     * which is what makes a truncating cursor produce a WRONG count rather than a short one.
     */
    const dir = freshDir();
    const path = join(dir, "monet.db");
    const core = new MonetCore(path, { embedder: new HashingEmbeddingProvider() });
    await core.ensureEmbedderPin();
    await core.store(ENGLISH);
    const db = (core as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db;
    const insert = db.prepare(
      `INSERT INTO observations (id, content, embedding, author_agent_id) VALUES (?, ?, '[]', 'test')`,
    );
    let seededKorean = 0;
    for (let i = 0; i < 600; i++) {
      const korean = i % 3 === 0;
      if (korean) seededKorean++;
      insert.run(`page-${String(i).padStart(4, "0")}`, korean ? `${KOREAN} ${i}` : `${ENGLISH} ${i}`);
    }
    core.close();

    const n = inspectStoredEmbedderState(path).nonLatin;
    expect(n.status).toBe("known");
    if (n.status !== "known") return;
    expect(seededKorean).toBeGreaterThan(500 / 3); // the fixture really does span pages
    expect(n.observationCount).toBe(seededKorean);
  });

  it("reads through a connection that already OWNS the store — a second handle is locked out (#14)", async () => {
    /*
     * `repair` re-reads this count after createVerifiedBackup has taken exclusive ownership, so the
     * read has to be expressible against the owning connection. It used to call
     * inspectStoredEmbedderState, which opens its own handle; that handle waits out its busy
     * timeout against its own process's lock and fails SQLITE_BUSY, which deadlocked every
     * English-only repair target.
     *
     * Asserted under REAL exclusive ownership, not merely through a port: ownership is the
     * condition that broke the old reader, so a test taking it any other way would pass on code
     * that still cannot run where the check has to run.
     */
    const path = await seed(new HashingEmbeddingProvider(), [KOREAN, ENGLISH, MOSTLY_ENGLISH]);
    const unowned = inspectStoredEmbedderState(path).nonLatin;

    const port = new BetterSqlitePort(path);
    try {
      port.acquireExclusiveOwnership();
      const owned = inspectNonLatinContent(port);
      expect(owned).toEqual(unowned);
      expect(owned.status).toBe("known");
      if (owned.status !== "known") return;
      expect(owned.observationCount).toBe(1);
      expect(owned.conceptCount).toBe(1);
    } finally {
      port.close();
    }
  });

  it("reports an unreadable schema as NOT KNOWN rather than as a zero", () => {
    // A caller's own connection can be pointed at something that is not a Monet store. "0 non-Latin
    // rows" and "the scan could not run" send an operator to opposite decisions on a one-way
    // rewrite, so the shape that cannot be mistaken for a verdict is the only safe one here.
    const dir = freshDir();
    const port = new BetterSqlitePort(join(dir, "empty.db"));
    try {
      const n = inspectNonLatinContent(port);
      expect(n.status).toBe("unknown");
    } finally {
      port.close();
    }
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
