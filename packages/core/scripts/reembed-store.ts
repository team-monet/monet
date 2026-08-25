/**
 * Re-embed a store COPY's OBSERVATIONS AND SEGMENTS with a different model, so a measurement that
 * reads those two populations can be run against the candidate space unchanged (#155).
 *
 * IT DOES NOT TOUCH CONCEPT VECTORS, and a measurement that reads them will silently answer about the
 * OLD space while every count looks healthy — that is not hypothetical, it produced a confident and
 * completely wrong edgeSimMin reading for bge-m3 (pair median 0.7082 against the real 0.4217, and
 * "no selective floor exists here" against a floor that plainly does). The nomination replays are
 * safe because they compare observation segments only. For anything concept-level, migrate a copy
 * with migrateEmbeddings, whose reembedConcept phase rewrites them.
 *
 *   MONET_DB=/path/to/copy.db MODEL=Xenova/bge-small-en-v1.5 npx tsx scripts/reembed-store.ts
 *
 * This is a MEASUREMENT fixture, not the migration. The real path is embedder_migration, which
 * arbitrates the pin, holds a lock, and rewrites vectors under ownership checks. This deliberately
 * has none of that: it exists so a candidate embedder can be evaluated on the corpus that would
 * govern it, before anyone commits to a pin. Point it at a copy.
 */
import Database from "better-sqlite3";
import { embToJson } from "../src/embedding";
import { OnnxEmbeddingProvider } from "../src/embedding-onnx";

const DB = process.env.MONET_DB!;
const MODEL = process.env.MODEL!;
/*
 * POOLING and DTYPE are part of the candidate SPACE, not decoration on the model id: a checkpoint
 * pooled the way it was not trained, or loaded at a quantized precision, produces vectors a measured
 * band would not transfer to. They are settable here for the same reason MODEL is — so an arm can be
 * built and replayed before anything commits to it.
 */
const POOLING = process.env.POOLING as "mean" | "cls" | undefined;
const DTYPE = process.env.DTYPE;

async function main(): Promise<void> {
  const db = new Database(DB);
  const provider = new OnnxEmbeddingProvider({ model: MODEL, dim: Number(process.env.DIM) || undefined, pooling: POOLING, dtype: DTYPE });
  const warmup = await provider.embed("warmup");

  // NATIVE-ONLY ON BOTH POPULATIONS. The observation query has always filtered `kind != 'source'`;
  // the segment query did not, so a prepped copy came out in a THIRD state nobody described — source
  // observations on the old model, their own segments on the new one. Aligning them means the
  // provenance marker below can state what was rewritten in one sentence and have it be true.
  const segs = db.prepare(
    `SELECT s.observation_id AS observation_id, s.segment_index AS segment_index, s.content AS content
       FROM observation_segments s
       JOIN observations o ON o.id = s.observation_id
      WHERE o.kind != 'source'`,
  ).all() as Array<{ observation_id: string; segment_index: number; content: string }>;
  const obs = db.prepare(`SELECT id, content FROM observations WHERE kind != 'source'`)
    .all() as Array<{ id: string; content: string }>;
  // THE EFFECTIVE SPACE, not the requested model (Codex review, PR #178). A copy written with
  // POOLING=cls DTYPE=q8 and one written with the defaults differ in every vector and in nothing
  // else: same file name, same row counts, same pin, and — before this line — the same log. These
  // copies are what the calibration scripts read, so an ambiguous provenance line is how a
  // measurement gets attributed to a space that did not produce it.
  console.log(
    `re-embedding ${obs.length} observations and ${segs.length} segments as `
      + `${provider.modelId ?? `${MODEL} (off-profile: no id names this space)`} `
      + `[pooling=${POOLING ?? "profile default"}, dtype=${DTYPE ?? "profile default"}, dim=${warmup.length}]`,
  );

  /*
   * PROVENANCE, WRITTEN INTO THE COPY — the durable half of the note above.
   *
   * That note fixed the LOG so a run says which space it produced. A log scrolls away; the .db file
   * is what a calibration script opens days later, and it carries no trace of this run at all. Width
   * cannot supply one: swapping one 384-dim model for another, or re-running the SAME model at a
   * different pooling or dtype, rewrites every vector and changes NO observable property of the
   * file. `sync_meta` still names the old pin, the concept vectors are still in the old space, and a
   * header sampling widths reports a tidy, uniform, WRONG answer. The only fix is for the run to say
   * so in the copy, which is what this row is.
   *
   * TWO-PHASE, AND OPENED BEFORE THE FIRST VECTOR MOVES. Publishing only on success is what the
   * first version did, and it made an interruption invisible in the worst possible way: a rerun that
   * dies partway leaves the PREVIOUS run's row standing over a store that is now half one space and
   * half another, and the row reads as authoritative. Same-width swaps evade even the dimension
   * check, so nothing anywhere would notice. The engine's own `embedder_migration` table solves this
   * with a sentinel — present means interrupted, absent means completed (findings §1) — and this is
   * that idea shaped for a row that must SURVIVE completion: `completed_at` NULL means the
   * preparation is still running or died, and the vectors are a mix that no identity describes.
   *
   * ONE ROW, REPLACED ON RE-RUN: the last preparation is the state of the file, and a history of
   * superseded preparations would just be another thing to read wrong.
   *
   * THIS SCRIPT ONLY EVER TOUCHES THE COPY IT WAS POINTED AT. It opens MONET_DB read-write and is
   * documented from its first line as a fixture builder for a COPY — the live store is not involved
   * here, and pointing this at one was already destructive before this table existed.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS reembed_provenance (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      candidate_model_id TEXT,
      requested_model TEXT NOT NULL,
      pooling TEXT,
      dtype TEXT,
      measured_dim INTEGER NOT NULL,
      populations TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );
  `);
  db.prepare(
    `INSERT INTO reembed_provenance
       (singleton, candidate_model_id, requested_model, pooling, dtype, measured_dim, populations,
        started_at, completed_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(singleton) DO UPDATE SET
       candidate_model_id = excluded.candidate_model_id, requested_model = excluded.requested_model,
       pooling = excluded.pooling, dtype = excluded.dtype, measured_dim = excluded.measured_dim,
       populations = excluded.populations, started_at = excluded.started_at,
       completed_at = NULL`, // the previous run's completion never carries over onto this one
  ).run(
    // NULL, not a fabricated id, when the checkpoint is off-profile: modelId is undefined exactly
    // when nothing names this space, and `requested_model` still records what was asked for.
    provider.modelId ?? null,
    MODEL,
    POOLING ?? null,
    DTYPE ?? null,
    warmup.length,
    "observations+segments where kind != 'source'; concepts and sync_meta UNTOUCHED",
    Date.now(),
  );

  const updSeg = db.prepare(`UPDATE observation_segments SET embedding = ? WHERE observation_id = ? AND segment_index = ?`);
  let i = 0;
  for (const s of segs) {
    const v = embToJson(await provider.embed(s.content));
    db.transaction(() => updSeg.run(v, s.observation_id, s.segment_index))();
    if (++i % 500 === 0) console.log(`  segments ${i}/${segs.length}`);
  }
  const updObs = db.prepare(`UPDATE observations SET embedding = ? WHERE id = ?`);
  i = 0;
  for (const o of obs) {
    const v = embToJson(await provider.embed(o.content));
    db.transaction(() => updObs.run(v, o.id))();
    if (++i % 500 === 0) console.log(`  observations ${i}/${obs.length}`);
  }
  // PHASE 2 — publish. Only now is the copy fully in the candidate space, so only now may the row
  // claim to describe it. Anything that kills the process before this line leaves completed_at NULL,
  // which is the state measure-header.ts refuses to attribute rather than guessing at.
  db.prepare(`UPDATE reembed_provenance SET completed_at = ? WHERE singleton = 1`).run(Date.now());

  db.close();
  console.log(`done — provenance recorded in reembed_provenance (concepts and the pin are unchanged)`);
}
void main();
