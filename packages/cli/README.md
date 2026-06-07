# monet

**Local-first, state-centric memory for coding agents.** Open source (AGPL-3.0).

Monet gives your coding agent a memory that persists across sessions — not by hoarding
transcripts, but by maintaining structured **state**: decisions, conventions, errors, and
the relationships between them. It runs **100% locally** (SQLite + on-device embeddings)
and speaks **MCP**, so it drops into Claude Code, Cursor, VS Code, and other MCP hosts.

## Install

```sh
npm i -g @team-monet/monet
monet start        # run the MCP server (stdio)
```

Or wire it into your agent team with the [with-monet](https://github.com/team-monet/with-monet) harness.

## What's inside

- **State-centric substrate** — a two-layer observation/concept store with resolve-or-create dedup.
- **Contradiction & drift handling**, **session-state survival**, and **query-independent prewarm**.
- **On-device embeddings** (MiniLM via ONNX, with a lexical fallback) — your data never leaves your machine.

The engine is [`@team-monet/core`](https://github.com/team-monet/monet-core); this package is
the local runtime (MCP server + CLI) built around it.

## License

Monet is licensed under **AGPL-3.0-only** (see [LICENSE](./LICENSE)) — free to use, study,
modify, self-host, and contribute. Under AGPL's copyleft, anyone who conveys a modified
version, or offers it to others over a network, must release their corresponding source
under the same terms. **Commercial licenses without AGPL obligations are available from the
copyright holder.**
