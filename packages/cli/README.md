# monet

**Memory should change what your agent does.**

[![npm](https://img.shields.io/npm/v/@team-monet/monet)](https://www.npmjs.com/package/@team-monet/monet) [![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.team--monet%2Fmonet-1f6feb)](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.team-monet/monet) [![Website](https://img.shields.io/badge/website-team--monet.com-6E56CF)](https://team-monet.com/)

🌐 **[team-monet.com](https://team-monet.com/)** · listed on the **[MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.team-monet/monet)**

Monet is local-first memory for coding agents, built for the outcome you meant. It keeps what you and your team actually want — principles, rules, corrections — and delivers it while the agent works: principles always on, rules read at the moment they bind, corrections recorded so they never need making twice. It runs **100% locally** (SQLite + on-device embeddings) and speaks **MCP**.

## Get started — let your agent set it up

The easiest way to use Monet is to let your agent install and wire it for you. Paste one line into Claude Code (more agents coming soon):

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

## Diagnose and repair an embedder store — `monet doctor` / `monet repair`

If Monet reports an embedder pin mismatch, an interrupted embedding migration, malformed vectors, or an unavailable local model, start with the read-only diagnostic command:

```bash
monet doctor
monet doctor --check-provider       # also load and probe the exact pinned provider
monet doctor --dir ~/.monet --json  # machine-readable result; diagnostics stay on stderr
```

`doctor` prints the absolute database path, SQLite integrity and schema, the durable model pin, all four live embedding populations (including dimensions and malformed-row samples), any migration sentinel, and copy-paste next commands. It does not construct `MonetCore` or alter the database. A healthy diagnosis exits `0`; a completed diagnosis that needs recovery or provider action exits `2`; inspection failures exit `1`. An unavailable provider is reported separately from store safety—for example, an unsupported hashing tokenizer or missing ONNX cache does not by itself mean the database is corrupt. For an ONNX or custom model ID whose shape cannot be proven from the pin alone, `--check-provider` can reconcile an otherwise `unknown` assessment only when the exact provider loads and every clean live population has the same matching vector width.

Repairs are previews unless both confirmation flags are present. Choose exactly one mode:

```bash
# Preview a complete rewrite to a built-in provider alias.
monet repair --target hashing
monet repair --target onnx

# Exact persisted model IDs are also accepted (quote them in scripts).
monet repair --target 'hashing:dim=256:tok=2' --json

# Apply only after reviewing the preview; this command never prompts.
monet repair --target hashing --apply --yes

# An interrupted migration must use the sentinel's exact target.
monet repair --resume
monet repair --resume --apply --yes

# Abandon is available only when core proves no vectors were rewritten and can restore the prior pin.
monet repair --abandon
monet repair --abandon --apply --yes
```

Preview classifies the durable state before offering an apply command. An empty unpinned store or a clean, provider-compatible same-target store reports `action: none`; no backup or rewrite is needed, and `--apply --yes` refuses. Abandon preview also refuses unless a sentinel exists and core diagnostics classify it as safe. A valid target or resume preview loads and probes the exact provider but does not open the database for mutation. Apply preflights the provider again, takes exclusive SQLite ownership, and creates a verified backup before core can migrate schema or embeddings. Backups are automatic and cannot be disabled or redirected:

```text
<storage-directory>/backups/monet-before-repair-<UTC>-<uuid>.db
```

The backup path is printed immediately and retained if later work fails. Stop other Monet processes if exclusive ownership cannot be acquired, then rerun the same command. Do not delete an active migration sentinel or edit the pin manually: use `--resume`, or use `--abandon` only when its preview says core classifies abandonment as safe. Successful previews and applies exit `0`; invalid flags, provider failures, locks, unsafe abandon attempts, backup failures, and migration failures exit `1`.

## Register Markdown sources — `monet source`

Linked sources keep living Markdown available to Monet as the files change. Use one when the file or repository remains the source of truth, such as a handbook, ADR tree, or agent instructions. Use the `memory_store` MCP tool for a point-in-time capture instead: a distilled decision, preference, constraint, or reason that should not silently change when a file is edited.

Sources are Git repositories: either an existing local clone or a remote repository Monet will clone and manage. The concise commands infer the internal source type, name, ACL, and exact transport policy:

```bash
# An existing clone. Run this from its parent or use an absolute path.
monet source add ./my-vault \
  --include "README.md" \
  --include "docs/**/*.md" \
  --exclude "docs/generated/**"

# A GitHub remote Monet will manage. This exact shorthand is canonicalized to ssh://.
monet source add git@github.com:org/docs.git \
  --branch main \
  --include "README.md" \
  --include "docs/**/*.md"
```

The local path must exist, be the exact Git worktree root, and have a committed `HEAD`; later syncs exclude working-tree changes. Remote sources require `--branch`. SCP shorthand is accepted only as `git@github.com:<owner>/<repo>[.git]`; use an explicit credential-free `ssh://user@host/owner/repo.git` URL for other SSH hosts or users. SSH remotes use the SSH agent inherited by Monet, so the Monet process must have the correct `SSH_AUTH_SOCK`; the command never embeds credentials in the stored URL.

When concise syntax omits `--include`, Monet registers `**/*.md`, selecting Markdown at the root and below without selecting artifact files. Any explicit `--include` replaces that default; repeat it to select multiple Markdown path sets. Include and exclude filters remain editable after registration.

`monet source add` only registers the source. It does **not** clone, scan, parse, ingest, or sync content during the command. Output includes the new source ID and internal type, origin, applied ACL and transport policy, `Content sync: not run`, and the MCP `source_sync` next step. Concise registration defaults the ACL to the exact caller and project IDs printed as `Server identity: caller … · project …`. Supplying `--allow-caller` or `--allow-project` replaces that field's default, so repeat the flag with both the printed identity and any additional identities that should have access. Use `--name "Project docs"` to override the name inferred from the repository directory or remote basename.

Copy the printed ID, inspect the registration, and compare the printed identity with its ACLs:

```bash
SOURCE_ID="<source-id printed by add>" # replace this placeholder
monet source show "$SOURCE_ID"

# Run this only if the printed server identity does not match the ACLs.
monet source update "$SOURCE_ID" \
  --allow-caller "<caller from Server identity>" \
  --allow-project "<project from Server identity>"
```

`local-agent` is the default caller. The default project ID is derived from the invocation repository's Git remote as `host/org/repo`; `MONET_CALLER_ID` and `MONET_PROJECT_ID` override them. Run the CLI against the same store as the MCP server: storage resolves through `MONET_STORAGE_DIR`, an existing `./.monet`, then `~/.monet`. For a one-off override, put `--dir` on `source`, for example `monet source --dir ./scratch-store list`.

The original explicit syntax remains available for scripts and advanced ACL/transport configuration. With `--type`, the positional value remains the display name and the existing required flags are unchanged:

```bash
CALLER_ID="local-agent"
PROJECT_ID="github.com/acme/widgets"

monet source add "Project docs" \
  --type repo-md \
  --path ./my-vault \
  --allow-caller "$CALLER_ID" \
  --allow-project "$PROJECT_ID"

monet source add "Shared handbook" \
  --type git-md \
  --circle shared-handbook \
  --remote "ssh://git@github.com/acme/handbook.git" \
  --branch main \
  --allow-scheme ssh \
  --allow-host github.com \
  --allow-caller "$CALLER_ID" \
  --allow-project "$PROJECT_ID"
```

Initial and manual syncs are MCP operations, not source CLI subcommands. Ask a connected agent to call `source_sync` with `{"sourceId":"<source-id>"}`. Registrations default to an hourly interval; an active `monet start` server runs due syncs in the background. Set `MONET_NO_SOURCE_SCHEDULER=1` on the server to disable scheduled syncs. Set an explicit cadence or switch to manual refresh with:

```bash
monet source update "$SOURCE_ID" --refresh interval --interval-seconds 1800
monet source update "$SOURCE_ID" --refresh manual
```

After syncing, ask the agent to call `source_status` with `{"sourceId":"<source-id>"}` and check `lastSyncResult`, `filesIndexed`, `filesSkipped`, and `freshness`, then spot-check a distinctive phrase with `memory_search`. Call `source_path` with the same argument to get the sealed, read-only path for the exact active indexed snapshot; it is not the source working tree or the registry's allocated local path. Only a complete published snapshot is exposed, never a partial run.

Use the CLI to list and inspect registry configuration:

```bash
monet source list
monet source list --json
monet source show "$SOURCE_ID"
monet source show "$SOURCE_ID" --json
monet source show "$SOURCE_ID" --path-only # registered local/allocated path
monet source update "$SOURCE_ID" \
  --include "handbook/**/*.md" \
  --exclude "handbook/private/**"
```

Include and exclude filters can be changed dynamically with `source update`; the next sync applies the new selection. `source update` replaces the mutable fields supplied on that invocation: name, include/exclude patterns, ACLs, Git transport policy, write-back policy, refresh policy, and auto-detection preference. Source type, circle, repository root, remote, and branch are immutable; remove and re-add the source to change them. Removal requires confirmation, creates a tombstone, and does not delete the registered path:

```bash
monet source remove "$SOURCE_ID" --yes
monet source list --include-tombstoned
monet source show "$SOURCE_ID" --include-tombstoned
```

When the Monet store is project-local, registering the repository root is safe: Monet permanently retains a source-relative exclusion for its managed `.monet/sources` subtree, including after `--clear-excludes`. A repository root equal to or inside that managed subtree is rejected. Active sources cannot share the same canonical local path; removing a source releases the path for a new source ID while preserving the old ID tombstone.

For the complete, version-matched option list, run `monet source --help` and `monet source <add|list|show|update|remove> --help`.

## License

Monet is distributed under a **proprietary license** — free to use for any purpose; redistribution, decompilation, and derivative works are not permitted. Full terms are in the `LICENSE` file included in this package.
