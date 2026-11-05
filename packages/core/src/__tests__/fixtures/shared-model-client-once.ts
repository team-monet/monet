import { createSharedModelHost } from "../../shared-model";

// A process whose only remaining work is one pending embed, which is what `monet start` is before
// its transport exists. It must wait for the answer, print it, and then end by itself.
const [hostEntry, runtimeDir, tsx] = process.argv.slice(2) as [string, string, string];
const host = createSharedModelHost({ version: "client-once", hostEntry, runtimeDir, nodeArgs: ["--import", tsx] });
const vector = await host.embed({ model: "owner/model", pooling: "cls" }, "hi");
console.log(`answered ${vector.length}`);
