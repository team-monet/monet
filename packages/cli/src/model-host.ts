import { serveSharedModel } from "@team-monet/core";

// Started by the first session that needs the embedding model; see @team-monet/core's shared-model.
// Its own entry point rather than a subcommand: when ten sessions start at once, nine of these lose
// the election and exit, and none of them should pay for loading the whole command line first.
const basePath = process.argv[2];
if (!basePath) {
  console.error("model-host is started by `monet start`, with a base path as its argument.");
  process.exit(2);
}

const server = await serveSharedModel({ basePath });
if (server !== null) await server.closed;
// Explicit: the model runtime's native threads do not end on their own when the event loop drains.
process.exit(0);
