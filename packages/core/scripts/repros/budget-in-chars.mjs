// Is 512 tokens a fair budget across the scripts this store actually holds?
// A token budget is not a character budget, and the ratio is script-dependent — so the SAME limit
// buys very different amounts of writing depending on the language.
import { readFileSync } from "node:fs";
import { env, AutoTokenizer } from "@huggingface/transformers";
// Fail closed rather than fetch (Codex review, PR #133): a probe that silently downloads a
// missing model mutates the cache it is measuring and breaks the no-network reproducibility
// this document claims. Set BEFORE any load.
env.allowRemoteModels = false;

const tok = await AutoTokenizer.from_pretrained("Xenova/paraphrase-multilingual-MiniLM-L12-v2", { cache_dir: process.env.CACHE });
const rows = JSON.parse(readFileSync(process.env.ROWS, "utf8"));
const bucket = (t) => {
  const han = (t.match(/[가-힣]/g) ?? []).length;
  return han / t.length > 0.3 ? "korean-dominant" : han > 0 ? "mixed" : "latin-only";
};
const by = {};
for (const r of rows) {
  const n = tok.encode(r.content).length;
  (by[bucket(r.content)] ??= []).push(r.content.length / n);
}
console.log(`${"script".padEnd(18)}${"n".padStart(5)}${"chars/token".padStart(13)}${"512 tokens buys".padStart(18)}`);
for (const [k, v] of Object.entries(by).sort((a, b) => b[1].length - a[1].length)) {
  const s = v.sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  console.log(`${k.padEnd(18)}${String(s.length).padStart(5)}${med.toFixed(2).padStart(13)}${(Math.round(med * 512) + " chars").padStart(18)}`);
}
