# @monet/core

**Proprietary — state-centric memory substrate engine.**

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

## Status

Private repository. Not for distribution. Consumed by `monet-local` (and later the
example-host + `example-agent`) as a private package.
