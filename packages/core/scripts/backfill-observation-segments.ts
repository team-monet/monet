/**
 * Backfill the bounded retrieval unit over already-stored memory (#155).
 *
 *   MONET_DB=/path/to/monet.db npx tsx scripts/backfill-observation-segments.ts [--circle NAME]
 *
 * WHY A SCRIPT AND NOT A STARTUP MIGRATION. Segmentation embeds, so its cost scales with the store
 * and with the model, and a store that opens is expected to serve immediately. The write path already
 * segments every new observation in its own transaction, so a store that is never backfilled is
 * CORRECT and merely coarser — scoreNativeConceptsByObservation falls back to the observation's own
 * vector for rows without segments, which is exactly the pre-#155 behavior. Backfill is therefore a
 * quality upgrade to be run deliberately, not a correctness prerequisite to be run on every open.
 *
 * SAFE TO RERUN, INCLUDING AFTER AN EMBEDDER MIGRATION. The unit of replacement is the observation:
 * each one's segments are deleted and reinserted in a single transaction, so a rerun grows nothing
 * and an interrupt leaves every observation either fully re-segmented or untouched. A migration drops
 * segments as it rewrites vectors, so re-running this afterwards is how they come back in the new
 * space.
 *
 * Point MONET_DB at a COPY first if you want to measure before committing to it.
 */
import { MonetCore } from "../src/engine";
import { chooseStartupEmbedder } from "./mcp-cli";

async function main(): Promise<void> {
  const dbPath = process.env.MONET_DB;
  if (!dbPath) {
    console.error("set MONET_DB to the store to backfill (use a copy to rehearse)");
    process.exit(2);
  }
  const circleFlag = process.argv.indexOf("--circle");
  const circle = circleFlag >= 0 ? process.argv[circleFlag + 1] : undefined;

  const core = new MonetCore(dbPath, { embedder: await chooseStartupEmbedder(dbPath) });
  await core.ensureEmbedderPin();

  const started = process.hrtime.bigint();
  let lastLogged = 0;
  const result = await core.resegmentObservations({
    circle,
    onProgress: (done, total) => {
      // One line per 10%, so a long run shows progress without flooding a log.
      const decile = Math.floor((done / Math.max(total, 1)) * 10);
      if (decile > lastLogged || done === total) {
        lastLogged = decile;
        console.log(`  ${done}/${total} observations`);
      }
    },
  });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;

  console.log(
    `\nre-segmented ${result.observations} observations into ${result.segments} segments ` +
      `(${(result.segments / Math.max(result.observations, 1)).toFixed(2)} per observation) in ${seconds.toFixed(1)}s`,
  );
  core.close();
}

void main();
