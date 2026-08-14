// How much of the live store is past the embedding model's 512-token window, and therefore
// absent from its own vector? Tokenizes a random sample of LIVE observations.
import { readFileSync } from "node:fs";
import { env, AutoTokenizer } from "@huggingface/transformers";
// Fail closed rather than fetch (Codex review, PR #133): a probe that silently downloads a
// missing model mutates the cache it is measuring and breaks the no-network reproducibility
// this document claims. Set BEFORE any load.
env.allowRemoteModels = false;

const tok = await AutoTokenizer.from_pretrained("Xenova/paraphrase-multilingual-MiniLM-L12-v2", { cache_dir: process.env.CACHE });
const rows = JSON.parse(readFileSync(process.env.ROWS, "utf8"));
const LIMIT = 512;
let over = 0, totalTok = 0, lostTok = 0;
const byCircle = {};
for (const r of rows) {
  const n = tok.encode(r.content).length;
  totalTok += n;
  if (n > LIMIT) {
    over++; lostTok += n - LIMIT;
    byCircle[r.circle] = (byCircle[r.circle] ?? 0) + 1;
  }
}
console.log(`live observations sampled : ${rows.length}`);
console.log(`over the 512-token window : ${over}  (${(over / rows.length * 100).toFixed(1)}%)`);
console.log(`tokens in sample          : ${totalTok}`);
console.log(`tokens never embedded     : ${lostTok}  (${(lostTok / totalTok * 100).toFixed(1)}% of all text)`);
console.log(`truncated rows by circle  :`, byCircle);
