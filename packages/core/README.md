# @team-monet/core

State-centric memory substrate engine.

## Install

```sh
npm install @team-monet/core
# or
pnpm add @team-monet/core
```

## Usage

```ts
import { MonetCore, createLocalEmbedder, deriveCircle, createMonetCoreMcpServer } from "@team-monet/core";

// One local SQLite store, partitioned per project by `circle`.
const core = new MonetCore("memory.db", {
  embedder: await createLocalEmbedder(),        // on-device MiniLM, lexical fallback
  defaultCircle: deriveCircle(process.cwd()),   // per-working-tree isolation
});

await core.store("CI runs fully offline; no network calls in the test suite.");
const cards = await core.search("how does CI run?");  // structural cards (ids/titles), not bodies
console.log(core.stats());                            // { concepts, observations, workstreams, … }

// Or expose the same engine to an MCP host:
await createMonetCoreMcpServer(core);
```

## Scripts

- `pnpm build` — compile `src` → `dist` (library only).
- `pnpm test` — unit tests (vitest).
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm embed:check` — calibrate/verify the local embedder (needs the optional `@huggingface/transformers`).
- `pnpm mcp` / `pnpm mcp:smoke` — run / smoke-test the MCP server.

## License

Proprietary and Confidential — see [LICENSE](./LICENSE).
