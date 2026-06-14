# monet

**Local-first, state-centric memory for coding agents.**

Monet gives your coding agent a memory that persists across sessions — not by hoarding transcripts, but by maintaining structured **state**: decisions, conventions, errors, and the relationships between them. It runs **100% locally** (SQLite + on-device embeddings) and speaks **MCP**.

## Get started — let your agent set it up

The easiest way to use Monet is to let the coding agent you already use install and wire it for you. Paste one line into your agent:

> **Set up Monet for all my projects: read https://raw.githubusercontent.com/team-monet/with-monet/main/bootstrap/install.md and follow it, checking with me at each step.**

Your agent installs Monet, wires up the MCP server, and pulls in a memory-aware agent team — **no manual config, no environment variables.** That's the **[with-monet](https://github.com/team-monet/with-monet)** harness, and it's the recommended path.

> ⭐ **If Monet helps, [star with-monet on GitHub](https://github.com/team-monet/with-monet)** — it's the best way to support the project.

## Zero config

Monet keeps one local store at `~/.monet` and automatically isolates each project into its own *circle* — nothing to set up, and memory never bleeds between repos. Everything stays on your machine.

## License

Monet is distributed under a **proprietary license** — free to use for any purpose; redistribution, decompilation, and derivative works are not permitted. Full terms are in the `LICENSE` file included in this package.
