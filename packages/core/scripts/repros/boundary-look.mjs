import { readFileSync } from "node:fs";
import { env, AutoTokenizer } from "@huggingface/transformers";
// Fail closed rather than fetch (Codex review, PR #133): a probe that silently downloads a
// missing model mutates the cache it is measuring and breaks the no-network reproducibility
// this document claims. Set BEFORE any load.
env.allowRemoteModels = false;

const tok = await AutoTokenizer.from_pretrained("Xenova/paraphrase-multilingual-MiniLM-L12-v2", { cache_dir: process.env.CACHE });
const rows = JSON.parse(readFileSync(process.env.ROWS, "utf8"));
const scored = rows.map((r) => ({ ...r, n: tok.encode(r.content).length }));
const band = scored.filter((r) => r.n >= 430 && r.n <= 512).sort((a, b) => b.n - a.n);
console.log(`=== observations that FIT, near the ceiling (430-512 tokens) — is this enough room? ===\n`);
for (const r of band.slice(0, 4)) {
  const paras = r.content.split(/\n\s*\n/).filter((p) => p.trim()).length;
  console.log(`[${r.kind}] ${r.n} tokens, ${r.content.length} chars, ${paras} paragraph(s)`);
  // Head AND tail (Codex review, PR #133): the claim these rows support is that they read as
  // FINISHED, and an ellipsis where the ending should be cannot show that.
  const flat = r.content.replace(/\s+/g, " ");
  console.log(flat.length <= 620 ? flat + "\n" : `${flat.slice(0, 300)}\n   …[${flat.length - 600} chars elided]…\n${flat.slice(-300)}\n`);
}
