// Is content past the model's window silently invisible?
// Append a highly distinctive sentence to the END of texts of increasing length.
// If the vector barely moves, the model never read the tail — that content is unindexed.
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
const FILLER = "The deployment pipeline runs migrations before the health check completes. ";
const MARKER = " The axolotl regenerates its limbs in the cenotes of Xochimilco.";
const probe = await emb("axolotl regeneration cenotes Xochimilco");
console.log("chars  tokens  cos(withMarker, withoutMarker)   cos(withMarker, markerQuery)");
for (const reps of [1, 5, 10, 20, 40, 80]) {
  const base = FILLER.repeat(reps);
  const [a, b] = [await emb(base), await emb(base + MARKER)];
  console.log(
    `${String(base.length).padEnd(7)}${String(tok.encode(base).length).padEnd(8)}` +
    `${cos(a, b).toFixed(4).padEnd(33)}${cos(b, probe).toFixed(3)}`,
  );
}
