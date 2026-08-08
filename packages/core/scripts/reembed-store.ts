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

  const segs = db.prepare(`SELECT observation_id, segment_index, content FROM observation_segments`)
    .all() as Array<{ observation_id: string; segment_index: number; content: string }>;
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
  db.close();
  console.log(`done`);
}
void main();
