# monet

**Local-first, state-centric memory for coding agents.**

Monet gives your coding agent a memory that persists across sessions — not by hoarding transcripts, but by maintaining structured **state**: decisions, conventions, errors, and the relationships between them. It runs **100% locally** (SQLite + on-device embeddings) and speaks **MCP**.

## Get started — let your agent set it up

The easiest way to use Monet is to let the coding agent you already use install and wire it for you. Paste one line into your agent:

> **Set up Monet for all my projects: read https://raw.githubusercontent.com/team-monet/with-monet/main/bootstrap/install.md and follow it, checking with me at each step.**

Your agent installs Monet, wires up the MCP server, and pulls in a memory-aware agent team — **no manual config, no environment variables.** That's the **[with-monet](https://github.com/team-monet/with-monet)** harness, and it's the recommended path.

> ⭐ **If Monet helps, [star with-monet on GitHub](https://github.com/team-monet/with-monet)** — it's the best way to support the project.

## Zero config

Monet keeps one local store at `~/.monet` and automatically **organizes** each project into its own *circle* — nothing to set up. Everything stays on your machine.

## See your memory — `monet dashboard`

Run one command to open a local web view of your Monet memory as an explorable, force-directed graph:

```bash
monet dashboard
```

It opens in your browser automatically. Nodes are concepts (colored by kind, sized by importance), edges are the relationships between them, and a detail panel lets you read any concept's full body and evidence. Timeline and Health views surface contradictions, duplicates, and low-confidence concepts.

**100% local. Fully offline. Strictly read-only.** The server copies your store into a temporary snapshot on each request — the live database is never written to or locked. No network connections are made; run it with wifi off and the graph still renders.

```bash
monet dashboard              # opens at http://localhost:7373
monet dashboard -p 8080      # -p, --port <n>   custom port
monet dashboard -d ./path    # -d, --dir <path>  point at a specific store
```

## License

Monet is distributed under a **proprietary license** — free to use for any purpose; redistribution, decompilation, and derivative works are not permitted. Full terms are in the `LICENSE` file included in this package.
