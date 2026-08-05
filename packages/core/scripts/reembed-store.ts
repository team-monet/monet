/**
 * Re-embed a store COPY with a different model, so every measurement script that reads stored
 * vectors can be run against the candidate space unchanged (#155).
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

async function main(): Promise<void> {
  const db = new Database(DB);
  const provider = new OnnxEmbeddingProvider({ model: MODEL });
  await provider.embed("warmup");

  const segs = db.prepare(`SELECT observation_id, segment_index, content FROM observation_segments`)
    .all() as Array<{ observation_id: string; segment_index: number; content: string }>;
  const obs = db.prepare(`SELECT id, content FROM observations WHERE kind != 'source'`)
    .all() as Array<{ id: string; content: string }>;
  console.log(`re-embedding ${obs.length} observations and ${segs.length} segments with ${MODEL}`);

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
