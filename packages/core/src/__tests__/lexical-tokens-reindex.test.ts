/**
 * THE POSTING LIST IS ONLY AS GOOD AS THE TOKENIZER THAT WROTE IT (#38, Codex P2 on PR #97).
 *
 * `observation_tokens` is a derived index over observation text. Changing the tokenizer invalidates
 * every row already in it, and on a store upgraded across #38 that is not merely stale recall: the
 * probe side reads Korean immediately (coverage is computed from the incoming text) while the
 * candidate side still holds Latin-only postings, so the margin gate can fire on half the evidence
 * and refuse a write that both the old and the correctly-indexed store accept.
 *
 * These tests pin the one-time re-tokenization that dissolves that state, and the mixed-encoding
 * defect that would otherwise reintroduce a version of it.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine";
import { HashingEmbeddingProvider } from "../embedding";
import { lexicalCoverage, lexicalTokens } from "../lexical-overlap";
import type { StoragePort } from "../storage";

const dbOf = (core: MonetCore): StoragePort => (core as unknown as { db: StoragePort }).db;
const CIRCLE = "reindex";

/** The pre-#38 tokenizer, verbatim, with no normalisation — what a legacy store's rows came from. */
const RETIRED = /[a-z0-9][a-z0-9_-]{2,}/gu;
const retiredTokens = (t: string): Set<string> => new Set(t.toLowerCase().match(RETIRED) ?? []);

const KO = "페리는 매시 십오분에 섬으로 출발한다";
const KO_WITH_ID = "zeta9 페리는 주말에만 항구에서 섬으로 출발한다";


/** Shared by both watermark describes below. */
const watermark = (core: MonetCore): string | null =>
  (dbOf(core).prepare(`SELECT lexical_tokens_reindexed_through AS w FROM sync_meta WHERE singleton = 1`)
      .get() as { w: string | null }).w;
const clockOf = (core: MonetCore): number =>
  (dbOf(core).prepare(`SELECT last_mutation_at AS t FROM sync_meta WHERE singleton = 1`).get() as { t: number }).t;
/**
 * Bring the mark up to the top of the table. A store's FIRST open happens before it holds any
 * observations, so the mark is set to NULL there and only reaches the newest row at the next open.
 * The scenario under test needs a mark that already sits at the top, which is what a real upgraded
 * store looks like — its first open sees every row it has.
 */
const settle = (dbPath: string): void => { open(dbPath).close(); };
/**
 * A pre-upgrade binary's store(): insert the observation, then write postings with the Latin-only
 * tokenizer. Bypasses the engine's tokenizer, because the engine cannot be made to emit the old
 * tokens any more — which is the point of the scenario.
 *
 * `sync_writer` IS LEFT NULL ON PURPOSE, matching the real insert (engine.ts store()): that is the
 * condition `sync_observations_insert` fires on, and the trigger is what advances the global
 * mutation clock. Binding it here would suppress the trigger and simulate a writer that does not
 * exist — an earlier draft of this helper did exactly that and made the repair look broken.
 */
function legacyWriterInserts(core: MonetCore, id: string, content: string): void {
  const db = dbOf(core);
  const donor = db.prepare(`SELECT embedding, circle, concept_id FROM observations LIMIT 1`)
    .get() as { embedding: string; circle: string; concept_id: string | null };
  db.prepare(
    `INSERT INTO observations
       (id, content, embedding, kind, circle, concept_id, author_agent_id, created_at)
     VALUES (?, ?, ?, 'statement', ?, ?, 'legacy-daemon', ?)`,
  ).run(id, content, donor.embedding, donor.circle, donor.concept_id, Date.now());
  const insert = db.prepare(`INSERT OR IGNORE INTO observation_tokens (observation_id, token) VALUES (?, ?)`);
  for (const token of retiredTokens(content)) insert.run(id, token);
}

function withStore(fn: (dbPath: string) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-lexical-reindex-"));
    try {
      await fn(join(dir, "monet-core.db"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const open = (dbPath: string): MonetCore =>
  new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(), tauAttach: 1.1, tauAmbiguous: 1.1 });

const sentinel = (core: MonetCore): number =>
  (dbOf(core).prepare(`SELECT lexical_tokens_version AS v FROM sync_meta WHERE singleton = 1`).get() as { v: number }).v;

const postingsFor = (core: MonetCore, observationId: string): Set<string> =>
  new Set((dbOf(core).prepare(`SELECT token FROM observation_tokens WHERE observation_id = ?`)
    .all(observationId) as Array<{ token: string }>).map((r) => r.token));

/** Put the store back into the state an upgrade across #38 produces: Latin-only rows, no sentinel. */
function downgradeToLegacy(core: MonetCore): void {
  const db = dbOf(core);
  const rows = db.prepare(`SELECT id, content FROM observations`).all() as Array<{ id: string; content: string }>;
  db.prepare(`DELETE FROM observation_tokens`).run();
  const insert = db.prepare(`INSERT OR IGNORE INTO observation_tokens (observation_id, token) VALUES (?, ?)`);
  for (const row of rows) for (const token of retiredTokens(row.content)) insert.run(row.id, token);
  db.prepare(`UPDATE sync_meta SET lexical_tokens_version = 0 WHERE singleton = 1`).run();
}

describe("one-time re-tokenization of the lexical posting list", () => {
  it("regenerates Latin-only postings with CJK grams at the next open, and stamps the sentinel", withStore(async (dbPath) => {
    let core = open(dbPath);
    const a = await core.store(KO, { circle: CIRCLE, resolution: "forceNew" });
    const b = await core.store(KO_WITH_ID, { circle: CIRCLE, resolution: "forceNew" });
    expect(a.conceptId).not.toBe(b.conceptId);
    // Keyed by CONTENT, never by id order: `open` supplies no idGen, so ids are random and an
    // `ORDER BY id` pairing would be right or wrong per run. (It was wrong roughly half the time —
    // caught only because the red-before run happened to draw the other order.)
    const idByText = new Map(
      (dbOf(core).prepare(`SELECT id, content FROM observations`).all() as Array<{ id: string; content: string }>)
        .map((r) => [r.content, r.id]),
    );
    expect(idByText.size).toBe(2);

    // PREMISE: force the store into the legacy shape, and assert it really is that shape — pure
    // Korean tokenizes to NOTHING under the retired tokenizer, which is the whole defect.
    downgradeToLegacy(core);
    expect(sentinel(core)).toBe(0);
    expect(postingsFor(core, idByText.get(KO)!).size).toBe(0);              // no ASCII at all
    expect([...postingsFor(core, idByText.get(KO_WITH_ID)!)]).toEqual(["zeta9"]); // the identifier only
    core.close();

    // THE FIX: reopening runs the pass.
    core = open(dbPath);
    expect(sentinel(core)).toBe(2);
    for (const text of [KO, KO_WITH_ID]) {
      const stored = postingsFor(core, idByText.get(text)!);
      expect(stored, text).toEqual(lexicalTokens(text));
      expect([...stored].some((t) => /[\p{scx=Hangul}]/u.test(t)), `${text} carries CJK grams`).toBe(true);
    }
    core.close();
  }));

  it("is a no-op on the second open — the sentinel is a version, and it is spent", withStore(async (dbPath) => {
    let core = open(dbPath);
    await core.store(KO, { circle: CIRCLE, resolution: "forceNew" });
    downgradeToLegacy(core);
    core.close();

    core = open(dbPath);
    expect(sentinel(core)).toBe(2);
    const afterFirst = (dbOf(core).prepare(`SELECT observation_id, token FROM observation_tokens ORDER BY observation_id, token`)
      .all() as Array<{ observation_id: string; token: string }>).map((r) => `${r.observation_id}|${r.token}`);
    expect(afterFirst.length).toBeGreaterThan(0);
    core.close();

    // A second open must not rewrite anything: same sentinel, byte-identical postings.
    core = open(dbPath);
    expect(sentinel(core)).toBe(2);
    const afterSecond = (dbOf(core).prepare(`SELECT observation_id, token FROM observation_tokens ORDER BY observation_id, token`)
      .all() as Array<{ observation_id: string; token: string }>).map((r) => `${r.observation_id}|${r.token}`);
    expect(afterSecond).toEqual(afterFirst);
    core.close();
  }));

  it("indexes an observation the old tokenizer left with no postings at all", withStore(async (dbPath) => {
    // The population this matters most for, and the one a per-observation "replace what is there"
    // pass would skip: pure Korean produced ZERO rows under the retired tokenizer, so there is
    // nothing to replace — only something to create.
    let core = open(dbPath);
    await core.store(KO, { circle: CIRCLE, resolution: "forceNew" });
    const id = (dbOf(core).prepare(`SELECT id FROM observations`).get() as { id: string }).id;
    downgradeToLegacy(core);
    expect(postingsFor(core, id).size).toBe(0);
    core.close();

    core = open(dbPath);
    expect(postingsFor(core, id).size).toBeGreaterThan(0);
    core.close();
  }));

  it("leaves a store written entirely by the current tokenizer byte-identical", withStore(async (dbPath) => {
    // Idempotence from the other direction: a store that never needed the pass must come out of it
    // unchanged, so running it can never be the thing that breaks a healthy index.
    let core = open(dbPath);
    await core.store(KO, { circle: CIRCLE, resolution: "forceNew" });
    await core.store(KO_WITH_ID, { circle: CIRCLE, resolution: "forceNew" });
    const before = (dbOf(core).prepare(`SELECT observation_id, token FROM observation_tokens ORDER BY observation_id, token`)
      .all() as Array<{ observation_id: string; token: string }>).map((r) => `${r.observation_id}|${r.token}`);
    expect(sentinel(core)).toBe(2); // a fresh store stamps on its very first open
    core.close();

    core = open(dbPath);
    const after = (dbOf(core).prepare(`SELECT observation_id, token FROM observation_tokens ORDER BY observation_id, token`)
      .all() as Array<{ observation_id: string; token: string }>).map((r) => `${r.observation_id}|${r.token}`);
    expect(after).toEqual(before);
    core.close();
  }));
});

describe("canonically equivalent text tokenizes identically (NFC)", () => {
  /*
   * Built from CODE POINTS, never from literal composed characters, because an editor or filesystem
   * can silently compose a decomposed literal on save — and a test comparing composed text to
   * composed text would pass no matter what the tokenizer does. The length assertions below exist
   * to prove these really are two different strings before anything is asserted about their tokens.
   */
  const KANA_NFC = "がき";                                     // がき
  const KANA_NFD = "がき";                               // か + combining dakuten + き
  const HANGUL_NFC = "한국";                                   // 한국, precomposed syllables
  const HANGUL_NFD = "한국";           // the same, conjoining Jamo

  it("composes Kana dakuten, which otherwise SPLITS the run and emits nothing", () => {
    expect(KANA_NFC).not.toBe(KANA_NFD);
    expect([...KANA_NFC].length).toBe(2);
    expect([...KANA_NFD].length).toBe(3); // the combining mark is the third
    // Without normalisation the dakuten is not in the CJK class, so it cuts か|き into two
    // one-character runs and the lone-run rule drops both — the decomposed text emits NOTHING.
    expect(lexicalTokens(KANA_NFD)).toEqual(lexicalTokens(KANA_NFC));
    expect(lexicalTokens(KANA_NFD).size).toBe(1);
  });

  it("composes Hangul Jamo, which otherwise produces grams no syllable can match", () => {
    expect(HANGUL_NFC).not.toBe(HANGUL_NFD);
    expect([...HANGUL_NFC].length).toBe(2);
    expect([...HANGUL_NFD].length).toBe(6);
    // Jamo are scx=Hangul too, so the decomposed form DOES emit — five bigrams over six Jamo, none
    // of which can ever equal a precomposed syllable bigram. Silent non-matching, not silence.
    expect(lexicalTokens(HANGUL_NFD)).toEqual(lexicalTokens(HANGUL_NFC));
    expect(lexicalTokens(HANGUL_NFD).size).toBe(1);
  });

  it("keeps the counting invariant across forms — coverage is a share of the SAME string", () => {
    // The denominator has to be counted on the normalised text too, or NFD `が` is two characters to
    // the denominator and one to the tokenizer.
    for (const [nfc, nfd] of [[KANA_NFC, KANA_NFD], [HANGUL_NFC, HANGUL_NFD]] as Array<[string, string]>) {
      expect(lexicalCoverage(nfd)).toBeCloseTo(lexicalCoverage(nfc), 10);
      expect(lexicalCoverage(nfd)).toBeCloseTo(1, 10);
    }
  });
});

/**
 * A store can be written by more than one binary at a time. Monet's primary deployment runs several
 * long-lived daemons against one file, and a daemon keeps its own build until its host restarts — so
 * an upgraded CLI can stamp the sentinel while a pre-upgrade server is still committing observations
 * with the old tokenizer. The sentinel alone would then skip the pass forever and leave those rows
 * mis-tokenized. These pin the trailing repair that heals them at the next open.
 */
describe("the trailing watermark repair — a legacy writer on a stamped store", () => {

  const rowidOf = (core: MonetCore, id: string): number =>
    (dbOf(core).prepare(`SELECT rowid AS r FROM observations WHERE id = ?`).get(id) as { r: number }).r;



  /**
   * A pre-upgrade binary's GRAFT of a higher-revision shell for an observation that already exists.
   * The real path is `INSERT ... ON CONFLICT(id) DO UPDATE SET <envelope columns>` — content is not
   * among them — followed by deleting that observation's postings and re-deriving them from the
   * payload text with whatever tokenizer is running. The row is updated IN PLACE, so its rowid never
   * moves and the position anchor cannot see it. `updated_at` is bound from `nextSyncTimestamp()`,
   * which bumps `last_mutation_at` first, so both are advanced here exactly as the graft does.
   */
  function legacyGraftRewrites(core: MonetCore, id: string, payloadText: string): void {
    const db = dbOf(core);
    db.prepare(
      `UPDATE sync_meta SET last_mutation_at = MAX(last_mutation_at + 1, ?) WHERE singleton = 1`,
    ).run(Date.now());
    const relayAt = clockOf(core);
    db.prepare(
      `UPDATE observations SET updated_at = ?, sync_revision = sync_revision + 1, sync_writer = 'legacy-peer' WHERE id = ?`,
    ).run(relayAt, id);
    db.prepare(`DELETE FROM observation_tokens WHERE observation_id = ?`).run(id);
    const insert = db.prepare(`INSERT OR IGNORE INTO observation_tokens (observation_id, token) VALUES (?, ?)`);
    for (const token of retiredTokens(payloadText)) insert.run(id, token);
  }


  it("re-tokenizes what a legacy writer added after the stamp, and advances the watermark", withStore(async (dbPath) => {
    let core = open(dbPath);
    await core.store(KO, { circle: CIRCLE, resolution: "forceNew" });
    core.close();
    settle(dbPath);
    core = open(dbPath);
    expect(sentinel(core)).toBe(2);
    const markBefore = watermark(core);
    expect(markBefore).not.toBeNull(); // the mark is at the top: only the TRAILING path can fire now

    // The pre-upgrade daemon commits a Korean observation while the store is already stamped.
    const clockBefore = clockOf(core);
    legacyWriterInserts(core, "legacy-obs-1", KO_WITH_ID);
    expect(clockOf(core), "premise: a real legacy write advances the mutation clock").toBeGreaterThan(clockBefore);
    expect([...postingsFor(core, "legacy-obs-1")]).toEqual(["zeta9"]); // Latin-only, as the old build wrote
    core.close();

    // A current build opens: the sentinel is already 2, so ONLY the watermark can catch this.
    core = open(dbPath);
    expect(sentinel(core)).toBe(2);
    expect(postingsFor(core, "legacy-obs-1")).toEqual(lexicalTokens(KO_WITH_ID));
    expect([...postingsFor(core, "legacy-obs-1")].some((t) => /[\p{scx=Hangul}]/u.test(t))).toBe(true);
    expect(watermark(core)).toBe("legacy-obs-1"); // moved past the row it just healed
    expect(watermark(core)).not.toBe(markBefore);
    core.close();
  }));

  it("does not rewrite anything when nothing lies beyond the watermark", withStore(async (dbPath) => {
    // THE FAST PATH. `observation_tokens` is a rowid table, so a DELETE+INSERT cycle would renumber
    // its rows — comparing rowids detects a rewrite that comparing (observation_id, token) pairs
    // would miss entirely.
    let core = open(dbPath);
    await core.store(KO, { circle: CIRCLE, resolution: "forceNew" });
    await core.store(KO_WITH_ID, { circle: CIRCLE, resolution: "forceNew" });
    core.close();
    settle(dbPath); // mark now at the top, so the next open has genuinely nothing to do
    core = open(dbPath);
    const before = dbOf(core).prepare(`SELECT rowid AS r, observation_id, token FROM observation_tokens ORDER BY rowid`).all();
    expect(before.length).toBeGreaterThan(0);
    const markBefore = watermark(core);
    expect(markBefore).not.toBeNull();
    core.close();

    core = open(dbPath);
    const after = dbOf(core).prepare(`SELECT rowid AS r, observation_id, token FROM observation_tokens ORDER BY rowid`).all();
    expect(after).toEqual(before);          // byte-identical, rowids included: nothing was rewritten
    expect(watermark(core)).toBe(markBefore);
    core.close();
  }));

  it("covers a trailing SOURCE observation rather than rescanning it every open", withStore(async (dbPath) => {
    // A source row is skipped for tokenizing but must still move the mark, or every later open pays
    // the scan again and the fast path above never engages.
    let core = open(dbPath);
    await core.store(KO, { circle: CIRCLE, resolution: "forceNew" });
    const db = dbOf(core);
    const donor = db.prepare(`SELECT embedding, circle FROM observations LIMIT 1`).get() as { embedding: string; circle: string };
    db.prepare(
      `INSERT INTO observations (id, content, embedding, kind, circle, author_agent_id, created_at, updated_at, sync_revision, sync_writer)
       VALUES ('src-1', ?, ?, 'source', ?, 'x', 1, 1, 1, 'x')`,
    ).run(KO, donor.embedding, donor.circle);
    core.close();
    settle(dbPath);

    core = open(dbPath);
    expect(watermark(core)).toBe("src-1");            // covered...
    expect(postingsFor(core, "src-1").size).toBe(0);  // ...but deliberately not indexed
    core.close();
  }));

  it("heals an in-place graft rewrite that never moved the row — the position anchor's blind spot", withStore(async (dbPath) => {
    // FINDING F. The graft updates an existing observation's ENVELOPE (`ON CONFLICT(id) DO UPDATE`,
    // rowid preserved) and re-derives its postings from the payload text. A legacy daemon doing that
    // below the watermark leaves Latin-only tokens on a row the rowid anchor has already passed.
    let core = open(dbPath);
    await core.store(KO, { circle: CIRCLE, resolution: "forceNew" });
    await core.store(KO_WITH_ID, { circle: CIRCLE, resolution: "forceNew" });
    core.close();
    settle(dbPath);

    core = open(dbPath);
    const victim = (dbOf(core).prepare(`SELECT id FROM observations WHERE content = ?`).get(KO) as { id: string }).id;
    const markBefore = watermark(core)!;
    const rowidBefore = rowidOf(core, victim);
    // PREMISE: the victim sits at or below the mark, so ONLY the clock dimension can reach it.
    expect(rowidBefore).toBeLessThanOrEqual(rowidOf(core, markBefore));
    expect(postingsFor(core, victim)).toEqual(lexicalTokens(KO)); // correct before the legacy graft

    legacyGraftRewrites(core, victim, KO);
    expect(postingsFor(core, victim).size).toBe(0);        // Latin-only tokenizer on pure Korean
    expect(rowidOf(core, victim)).toBe(rowidBefore);       // in place: the anchor cannot see this
    core.close();

    core = open(dbPath);
    expect(postingsFor(core, victim)).toEqual(lexicalTokens(KO));
    expect([...postingsFor(core, victim)].some((t) => /[\p{scx=Hangul}]/u.test(t))).toBe(true);
    core.close();
  }));

  it("never leaves the watermark ahead of what was actually tokenized", withStore(async (dbPath) => {
    // The invariant crash-safety exists to preserve. A true mid-transaction crash is not cheaply
    // reachable in-process — better-sqlite3 runs the whole pass inside one synchronous
    // `immediateTransaction`, so there is no yield point to interrupt — so this asserts the property
    // that transaction buys instead: everything at or below the mark really is current-tokenizer.
    let core = open(dbPath);
    await core.store(KO, { circle: CIRCLE, resolution: "forceNew" });
    await core.store(KO_WITH_ID, { circle: CIRCLE, resolution: "forceNew" });
    legacyWriterInserts(core, "legacy-obs-2", KO);
    core.close();

    core = open(dbPath);
    const mark = watermark(core)!;
    const markRow = rowidOf(core, mark);
    const covered = dbOf(core).prepare(
      `SELECT id, content, kind FROM observations WHERE rowid <= ? ORDER BY rowid`,
    ).all(markRow) as Array<{ id: string; content: string; kind: string }>;
    expect(covered.length).toBeGreaterThan(2);
    for (const row of covered) {
      if (row.kind === "source") continue;
      expect(postingsFor(core, row.id), row.id).toEqual(lexicalTokens(row.content));
    }
    core.close();
  }));
});

/**
 * The protocol-13 compatibility path mints observations rather than relaying them, and it was the
 * one insert into `observations` that never wrote the matching postings. It runs AFTER startup on a
 * store already stamped at the current tokenizer version, so the open-time rebuild is not coming
 * back for it — a Korean summary arriving this way had no lexical evidence at all.
 */
describe("a first_block pin converted from a legacy graft carries its postings", () => {
  it("tokenizes the converted observation in the graft transaction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-fb-graft-tokens-"));
    try {
      const KO_SUMMARY = "페리는 매시 십오분에 섬으로 출발한다";
      const sourcePath = join(dir, "source.db");
      const source = new MonetCore(sourcePath, { embedder: new HashingEmbeddingProvider(), tauAttach: 1.1, tauAmbiguous: 1.1 });
      const stored = await source.store("First block graft target.", { circle: CIRCLE, resolution: "forceNew" });
      const payload = source.exportDelta(0);
      source.close();

      // A protocol-13 peer still exports pins; the receiver converts them to evidence.
      payload.schemaVersion = 13;
      payload.firstBlock = [{
        id: "fb:legacy-korean-pin",
        concept_id: stored.conceptId,
        circle: CIRCLE,
        summary: KO_SUMMARY,
        summary_dirty: 0,
        position: 0,
        promoted_at: 1_700_000_000_000,
        promoted_by: null,
        updated_at: 1_700_000_000_000,
        sync_revision: 1,
        sync_writer: "legacy-peer",
        deleted_at: null,
      }];

      const receiver = new MonetCore(join(dir, "receiver.db"), {
        embedder: new HashingEmbeddingProvider(), tauAttach: 1.1, tauAmbiguous: 1.1,
      });
      expect(receiver.graftRows(payload).converted.first_block).toBe(1);

      const converted = dbOf(receiver).prepare(
        `SELECT id, content FROM observations WHERE author_agent_id = 'schema-12-first-block-migration'`,
      ).get() as { id: string; content: string };
      expect(converted).toBeDefined();
      expect(converted.content).toContain(KO_SUMMARY);

      // The point: postings exist, and they are the CJK grams the arm actually reads.
      const stored_tokens = postingsFor(receiver, converted.id);
      expect(stored_tokens).toEqual(lexicalTokens(converted.content));
      expect(stored_tokens.size).toBeGreaterThan(0);
      expect([...stored_tokens].some((t) => /[\p{scx=Hangul}]/u.test(t))).toBe(true);
      receiver.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The version comparison is one-directional. A newer tokenizer repairs what an older one wrote; an
 * older binary opening a store a newer one has stamped must leave the index completely alone, or it
 * rewrites the newest rows with the older tokenizer AND stamps the sentinel back down, leaving the
 * index mixed in both halves with the sentinel lying about both.
 */
describe("an older binary on a newer store touches nothing", () => {
  const meta = (core: MonetCore) =>
    dbOf(core).prepare(
      `SELECT lexical_tokens_version AS version, lexical_tokens_reindexed_through AS through,
              lexical_tokens_reindexed_at AS clock FROM sync_meta WHERE singleton = 1`,
    ).get() as { version: number; through: string | null; clock: number };

  it("leaves postings, sentinel and watermark untouched when the store is stamped ahead", withStore(async (dbPath) => {
    let core = open(dbPath);
    await core.store(KO, { circle: CIRCLE, resolution: "forceNew" });
    core.close();
    settle(dbPath);

    // A FUTURE build (version 3) owned this store: it stamped 3 and left its own watermark.
    core = open(dbPath);
    const futureMark = meta(core).through;
    dbOf(core).prepare(`UPDATE sync_meta SET lexical_tokens_version = 3 WHERE singleton = 1`).run();
    // ...and rows exist beyond that watermark, which is what would drag this build into the
    // trailing repair if the version guard were missing.
    legacyWriterInserts(core, "written-after-v3", KO_WITH_ID);
    const postingsBefore = dbOf(core).prepare(
      `SELECT observation_id, token FROM observation_tokens ORDER BY observation_id, token`,
    ).all();
    const metaBefore = meta(core);
    expect(metaBefore.version).toBe(3);
    core.close();

    // This build is version 2. It must decline entirely.
    core = open(dbPath);
    expect(meta(core).version).toBe(3);                    // NOT downgraded to 2
    expect(meta(core).through).toBe(futureMark);           // watermark unmoved
    expect(meta(core).clock).toBe(metaBefore.clock);       // clock unmoved
    expect(dbOf(core).prepare(
      `SELECT observation_id, token FROM observation_tokens ORDER BY observation_id, token`,
    ).all()).toEqual(postingsBefore);                      // not one posting rewritten
    core.close();
  }));
});
