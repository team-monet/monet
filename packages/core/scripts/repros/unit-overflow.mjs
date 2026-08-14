import { readFileSync } from "node:fs";
import { env, AutoTokenizer } from "@huggingface/transformers";
// Fail closed rather than fetch (Codex review, PR #133): a probe that silently downloads a
// missing model mutates the cache it is measuring and breaks the no-network reproducibility
// this document claims. Set BEFORE any load.
env.allowRemoteModels = false;

const tok = await AutoTokenizer.from_pretrained("Xenova/paraphrase-multilingual-MiniLM-L12-v2", { cache_dir: process.env.CACHE });
for (const f of process.env.FILES.split(",")) {
  const rows = JSON.parse(readFileSync(f, "utf8"));
  const lens = rows.map((r) => tok.encode(r.content).length).sort((a, b) => a - b);
  const q = (p) => lens[Math.min(lens.length - 1, Math.floor(lens.length * p))];
  const over = lens.filter((n) => n > 512).length;
  console.log(
    `${rows[0].origin.padEnd(7)} n=${lens.length}  median=${q(0.5)}  p75=${q(0.75)}  p90=${q(0.9)}  p99=${q(0.99)}  max=${lens[lens.length-1]}  over512=${(over/lens.length*100).toFixed(1)}%`,
  );
}
