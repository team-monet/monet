// Can Monet tell "several independent claims" from "one claim explained at length"?
// Segment the observation, embed each segment, and look at the pairwise cosines between segments.
// Mutually-far segments = distinct claims. This is resolution.ts's fork signal one level down,
// and it costs nothing extra: the segment vectors exist anyway, for the index.
//
// The parameter under test is SEGMENT SIZE. Cosines inflate with length (unrelated pairs run 0.19
// median under 300 chars but 0.75 over 1k), so a segment budget set at the model's 512-token window
// would sit inside the collapse zone and the signal would vanish.
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
const emb = async (t) => Array.from((await ex(t, { pooling: "mean", normalize: true })).data);

// Splits to the requested budget for real (Codex review, PR #133). The earlier version accepted an
// oversized paragraph whole whenever `cur` was empty, so the 128/256/512 comparison was partly
// measuring the SAME over-budget units at every setting — and, past the model window, silently
// truncated ones. A probe that does not honour its own parameter cannot support a conclusion about
// that parameter.
function splitToBudget(text, budgetTokens) {
  if (tok.encode(text).length <= budgetTokens) return [text];
  const sentences = text.split(/(?<=[.!?。？！])\s+|\n/).filter((x) => x.trim());
  const out = []; let cur = "";
  for (const piece of sentences) {
    const cand = cur ? `${cur} ${piece}` : piece;
    if (cur && tok.encode(cand).length > budgetTokens) { out.push(cur); cur = piece; } else cur = cand;
  }
  if (cur) out.push(cur);
  // A single sentence still over budget is cut by tokens, not characters — the point is that no
  // emitted unit exceeds what was asked for.
  return out.flatMap((u) => {
    const ids = tok.encode(u);
    if (ids.length <= budgetTokens) return [u];
    const parts = [];
    for (let i = 0; i < ids.length; i += budgetTokens) parts.push(tok.decode(ids.slice(i, i + budgetTokens), { skip_special_tokens: true }));
    return parts;
  });
}

function segment(text, budgetTokens) {
  const paras = text.split(/\n\s*\n/).filter((p) => p.trim());
  const out = []; let cur = "";
  for (const p of paras) {
    const cand = cur ? cur + "\n\n" + p : p;
    if (cur && tok.encode(cand).length > budgetTokens) { out.push(cur); cur = p; } else cur = cand;
  }
  if (cur) out.push(cur);
  return out.flatMap((u) => splitToBudget(u, budgetTokens));
}

for (const [label, file] of [["MULTI-CLAIM (mine)", process.env.MULTI], ["SINGLE-TOPIC (source doc)", process.env.SINGLE]]) {
  console.log(`\n### ${label}`);
  for (const r of JSON.parse(readFileSync(file, "utf8"))) {
    const line = [];
    for (const budget of [128, 256, 512]) {
      const segs = segment(r.content, budget);
      if (segs.length < 2) { line.push(`b=${budget}: 1 seg`); continue; }
      const vecs = []; for (const s of segs) vecs.push(await emb(s));
      const pw = [];
      for (let i = 0; i < vecs.length; i++) for (let j = i + 1; j < vecs.length; j++) pw.push(cos(vecs[i], vecs[j]));
      pw.sort((a, b) => a - b);
      line.push(`b=${budget}: ${String(segs.length).padStart(2)}seg median=${pw[Math.floor(pw.length/2)].toFixed(3)}`);
    }
    console.log(`  ${r.head.replace(/\n/g," ").padEnd(47)} ${line.join("  |  ")}`);
  }
}
