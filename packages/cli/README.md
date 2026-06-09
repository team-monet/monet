# monet

**Local-first, state-centric memory for coding agents.** Open source (AGPL-3.0).

Monet gives your coding agent a memory that persists across sessions — not by hoarding
transcripts, but by maintaining structured **state**: decisions, conventions, errors, and
the relationships between them. It runs **100% locally** (SQLite + on-device embeddings)
and speaks **MCP**, so it drops into Claude Code, Cursor, VS Code, and other MCP hosts.

## Install

```sh
npm i -g @team-monet/monet
```

Requires **Node ≥ 22**. Installs a native module (`better-sqlite3`) — most platforms pull a
prebuilt binary; others compile it on install (needs a C/C++ toolchain). The first
`monet start` downloads the on-device MiniLM embedding model **once** (a few seconds), then
runs fully offline.

Zero-install alternative: `npx -y @team-monet/monet start`.

## Quickstart — wire it into your agent

Monet is an **MCP server**: your agent host launches `monet start` and talks to it over
stdio, so `monet start` on its own just waits for a host to connect. Register it, then
restart your host.

**Claude Code** (one command — uses the shared global store, see below):

```sh
claude mcp add --scope user monet -- monet start
```

**Any host** — generate a config block to merge into its MCP settings:

```sh
monet config --agent claude-code   # or: cursor | hermes | openclaw
```

`monet config` prints a ready-to-paste entry (and defaults to a **per-repo** store):

```jsonc
{ "mcpServers": { "monet": { "command": "monet", "args": ["start"],
    "env": { "MONET_STORAGE_DIR": "<cwd>/.monet" } } } }
```

Restart your host so it picks up the server. On startup Monet logs its store and the active
project circle to stderr:

```
Monet started
Storage: /Users/you/.monet/monet.db
Circle:  my-repo-1a2b3c4d
```

Want a whole agent team wired in one paste, not just the server? Use the
[with-monet](https://github.com/team-monet/with-monet) harness.

## Where your memory lives

By default Monet keeps **one global store at `~/.monet`** and **isolates each project into
its own _circle_** — derived from your working tree (git root, else cwd) — so memory never
bleeds between repos while still sharing a single brain. The storage directory resolves in
this order:

1. `MONET_STORAGE_DIR`, if set;
2. else `./.monet` in the current directory, if it exists (a per-repo store);
3. else `~/.monet` (the shared global store).

Two ways to isolate projects, depending on how you registered Monet:

- **Shared store + circles** (default for `claude mcp add … monet start`): one `~/.monet`
  DB, logically partitioned per project by circle.
- **Per-repo store** (what `monet config` emits, via `MONET_STORAGE_DIR=<repo>/.monet`): a
  separate DB file per repo — a hard filesystem split. You can also pass `monet start --dir <path>`.

Inspect the current store:

```sh
monet status
```

## Commands

| Command | What it does |
|---|---|
| `monet start [--dir <path>]` | Run the MCP server over stdio. Your agent host spawns this. |
| `monet config [--agent <host>] [--yaml] [--output <file>]` | Print or write an MCP config block (`--agent`: `claude-code`, `cursor`, `hermes`, `openclaw`). |
| `monet status` | Show the storage path and store-wide counts (concepts, observations, workstreams, unsynthesized). |

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
