# monet

**Local-first, state-centric memory for coding agents.**

[![npm](https://img.shields.io/npm/v/@team-monet/monet)](https://www.npmjs.com/package/@team-monet/monet) [![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.team--monet%2Fmonet-1f6feb)](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.team-monet/monet) [![Website](https://img.shields.io/badge/website-monet.team--monet.com-6E56CF)](https://monet.team-monet.com/)

🌐 **[monet.team-monet.com](https://monet.team-monet.com/)** · listed on the **[MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.team-monet/monet)**

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

It opens in your browser automatically — if it doesn't (some Windows/headless setups), the terminal prints the URL (`http://localhost:7373`) and the store path; just visit that URL. The **Graph** tab is the main view: nodes are concepts (colored by kind, sized by importance), edges are the relationships between them, and a detail panel lets you read any concept's full body and evidence. The Concepts, Entities, Timeline, and Health tabs are sortable tables — Health surfaces contradictions, duplicates, and low-confidence concepts. If the graph looks empty, check the `Store:` line in the terminal: an empty graph usually means it's pointed at the wrong store (use `-d`) or the store is just new.

**100% local. Fully offline. Strictly read-only.** The server copies your store into a temporary snapshot on each request — the live database is never written to or locked. No network connections are made; run it with wifi off and the graph still renders.

```bash
monet dashboard              # opens at http://localhost:7373
monet dashboard -p 8080      # -p, --port <n>   custom port
monet dashboard -d ./path    # -d, --dir <path>  point at a specific store
```

## Register Markdown sources — `monet source`

The source commands configure the local registry only. They do **not** clone, scan, parse, ingest, or sync any content. A newly added source stays `pending-initial-sync` until a separate sync implementation is available.

Both source types use default-deny access lists, so at least one caller ID and one project ID are required:

```bash
# Register the current repository; --path defaults to the resolved project directory
monet source add "Project docs" \
  --type repo-md \
  --include "README.md" --include "docs/**/*.md" \
  --exclude "vendor/**" \
  --allow-caller local-agent --allow-project github.com/team-monet/monet-client

# Register a remote repository. Monet allocates the local path but does not clone it.
monet source add "Shared docs" \
  --type git-md --circle shared-docs \
  --remote https://github.com/acme/docs.git --branch main \
  --allow-scheme https --allow-host github.com \
  --allow-caller local-agent --allow-project github.com/team-monet/monet-client

monet source list
monet source list --json
monet source show <source-id>
monet source show <source-id> --path-only
monet source update <source-id> --include "handbook/**/*.md" --clear-excludes
monet source remove <source-id> --yes
```

`--allow-caller`/`--allow-project` must match the identity your server actually presents, not an arbitrary label: `local-agent` is the default caller ID (`--allow-caller codex` grants an ID no server ever presents unless `MONET_CALLER_ID=codex` is set), and the project ID defaults to `host/org/repo` derived from the invocation directory's git remote (`github.com/team-monet/monet-client` above, for this repo). Both `monet source add` and `monet source show` print the exact caller/project identity your running server will present, and either default can be overridden with the `MONET_CALLER_ID` / `MONET_PROJECT_ID` env vars.

`source update` changes mutable registry configuration only: name, include/exclude patterns, ACLs, Git transport policy, write-back policy, refresh policy, and auto-detection preference. Source identity (type, circle, repository/root, remote, and branch) is immutable; remove and add a new source to change it. Removal creates a tombstone and never deletes the registered local path.

When the Monet store is project-local, registering the repository root is safe: Monet permanently retains a source-relative exclusion for its managed `.monet/sources` subtree, including after `--clear-excludes`. A repo root equal to or inside that managed subtree is rejected. Active sources cannot share the same canonical local path; removing a source releases the path for a new source ID while preserving the old ID tombstone.

All source commands use the existing storage resolution (`MONET_STORAGE_DIR`, an existing `./.monet`, then `~/.monet`). To override it for one invocation, put `--dir` on the parent command, for example `monet source --dir ./scratch-store list`.

## License

Monet is distributed under a **proprietary license** — free to use for any purpose; redistribution, decompilation, and derivative works are not permitted. Full terms are in the `LICENSE` file included in this package.
