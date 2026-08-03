// Does the collapse come from truncation at the model's 512-token window?
// Embed a long document, then embed only its first N characters, and compare.
// If cos(full, prefix) ~= 1.0, the model never saw anything past the prefix.
import { readFileSync } from "node:fs";
import { env, pipeline, AutoTokenizer } from "@huggingface/transformers";
const M = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const cos=(a,b)=>{let d=0,na=0,nb=0;for(let i=0;i<a.length;i++){d+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];}return d/(Math.sqrt(na)*Math.sqrt(nb));};
// Fail closed rather than fetch (Codex review, PR #133): a probe that silently downloads a
// missing model mutates the cache it is measuring and breaks the no-network reproducibility
// this document claims. Set BEFORE any load.
env.allowRemoteModels = false;

const ex = await pipeline("feature-extraction", M, { cache_dir: process.env.CACHE });
const tok = await AutoTokenizer.from_pretrained(M, { cache_dir: process.env.CACHE });
const WINDOW = Number(process.env.WINDOW ?? 512);
const rows = JSON.parse(readFileSync(process.env.ROWS, "utf8"));
const emb = async (t) => Array.from((await ex(t, { pooling: "mean", normalize: true })).data);
console.log(`len   tokens  cos(full, first-${WINDOW}-tokens)  cos(full, SECOND half)`);
for (const r of rows) {
  const n = tok.encode(r.content).length;
  const full = await emb(r.content);
  // Prefix built from the first WINDOW tokens, not a character slice (Codex review, PR #133). A
  // 1,200-character slice encodes to far fewer than 512 tokens for Latin text, so `full` contained
  // model-visible tokens the prefix omitted and their cosine could differ even under exact
  // truncation — the probe could not establish the cutoff it was cited for.
  const head = await emb(tok.decode(tok.encode(r.content).slice(0, WINDOW), { skip_special_tokens: true }));
  const tail = await emb(r.content.slice(Math.floor(r.content.length / 2)));
  console.log(
    `${String(r.content.length).padEnd(6)}${String(n).padEnd(8)}${cos(full, head).toFixed(3).padEnd(29)}${cos(full, tail).toFixed(3)}`,
  );
}
