# @team-monet/core

**Open source under [AGPL-3.0](./LICENSE) — state-centric memory substrate engine.**

The core engine behind Monet (local-first memory):
two-layer observation/concept store, resolve-or-create dedup, lazy enrichment,
structural search cards, contradiction lifecycle, workstreams + session survival,
query-independent prewarm, and pluggable local embeddings (MiniLM via ONNX, with a
lexical hashing fallback).

Architecture: see ADR 0001 (state-centric memory substrate).

## Surfaces

- `MonetCore` — the pure in-process engine API.
- `createMonetCoreMcpServer` — an MCP-server adapter over the engine.

## Scripts

- `pnpm build` — compile `src` → `dist` (library only).
- `pnpm test` — unit tests (vitest).
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm embed:check` — calibrate/verify the local embedder (needs the optional `@huggingface/transformers`).
- `pnpm mcp` / `pnpm mcp:smoke` — run / smoke-test the MCP server.

## License

Monet Core is licensed under the **GNU Affero General Public License v3.0** (`AGPL-3.0-only`) — see [LICENSE](./LICENSE). You're free to use, study, modify, self-host, and contribute. Under AGPL's copyleft, anyone who conveys a modified version — or offers it to others over a network — must release their corresponding source under the same terms. **Commercial licenses without AGPL obligations are available from the copyright holder.**

## Status

Public, open source under AGPL-3.0. Consumed by `monet` (the open client) and, internally, by the example-host and `example-agent`.
