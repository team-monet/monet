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
