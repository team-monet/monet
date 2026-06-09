# @team-monet/core

**Open source under [AGPL-3.0](./LICENSE) — state-centric memory substrate engine.**

The core engine behind Monet (local-first memory):
two-layer observation/concept store, resolve-or-create dedup, lazy enrichment,
structural search cards, contradiction lifecycle, workstreams + session survival,
query-independent prewarm, and pluggable local embeddings (MiniLM via ONNX, with a
lexical hashing fallback).

Architecture: two layers — raw **observations** (what was seen, with provenance) distil into
durable **concepts** (what's true now). Writes resolve-or-create against existing concepts, and
contradictions are tracked and mediated rather than silently overwritten.

## Surfaces

- `MonetCore` — the pure in-process engine API (`store`, `search`, `gather`, `checkpoint`, `overview`, …).
- `createMonetCoreMcpServer` — an MCP-server adapter that exposes the engine over stdio.
- `createLocalEmbedder` — the on-device MiniLM embedder (with a lexical fallback).
- `deriveCircle` — a stable per-project *circle* from the working tree, so one shared store isolates each repo.

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

// Or expose the same engine to an MCP host (this is what @team-monet/monet does):
await createMonetCoreMcpServer(core);
```

Most users don't import this directly — they install [`@team-monet/monet`](https://github.com/team-monet/monet),
the local-first MCP server + CLI built on this engine.

## Scripts

- `pnpm build` — compile `src` → `dist` (library only).
- `pnpm test` — unit tests (vitest).
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm embed:check` — calibrate/verify the local embedder (needs the optional `@huggingface/transformers`).
- `pnpm mcp` / `pnpm mcp:smoke` — run / smoke-test the MCP server.

## License

Monet Core is licensed under the **GNU Affero General Public License v3.0** (`AGPL-3.0-only`) — see [LICENSE](./LICENSE). You're free to use, study, modify, self-host, and contribute. Under AGPL's copyleft, anyone who conveys a modified version — or offers it to others over a network — must release their corresponding source under the same terms. **Commercial licenses without AGPL obligations are available from the copyright holder.**

## Status

Public, open source under AGPL-3.0. Consumed by `monet` (the open local client).
