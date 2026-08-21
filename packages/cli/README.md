# monet

**Memory should change what your agent does.**

[![npm](https://img.shields.io/npm/v/@team-monet/monet)](https://www.npmjs.com/package/@team-monet/monet) [![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.team--monet%2Fmonet-1f6feb)](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.team-monet/monet) [![Website](https://img.shields.io/badge/website-team--monet.com-6E56CF)](https://team-monet.com/)

🌐 **[team-monet.com](https://team-monet.com/)** · listed on the **[MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.team-monet/monet)**

Monet is local-first memory for coding agents, built for the outcome you meant. It keeps what you and your team actually want — principles, rules, corrections — and delivers it while the agent works: principles always on, rules read at the moment they bind, corrections recorded so they never need making twice. It runs **100% locally** (SQLite + on-device embeddings) and speaks **MCP**.

## Get started — let your agent set it up

The easiest way to use Monet is to let your agent install and wire it for you. Paste one line into Claude Code (more agents coming soon):

> **Set up Monet for all my projects: read https://raw.githubusercontent.com/team-monet/monet/main/harness/bootstrap/install.md and follow it, checking with me at each step.**

Your agent installs Monet, wires up the MCP server, and pulls in a memory-aware agent team — **no manual config, no environment variables.** That's the **with-monet** harness, which lives in `harness/` in the [Monet repo](https://github.com/team-monet/monet), and it's the recommended path.

> ⭐ **If Monet helps, [star Monet on GitHub](https://github.com/team-monet/monet)** — it's the best way to support the project.

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

### When the server will not start at all

A host that cannot start the server reports only that the connection closed — the transport does not exist until every fallible startup step has already succeeded, so there is no protocol channel left to explain a failure. The cause is written beside the store instead, at `startup-failure.json` next to `monet.db`: the step it died in, the error and its code, the time, and the pid. `doctor` prints that record on stderr before anything else, including when the store itself is too damaged to inspect.

The record holds only the most recent failure, and a later successful start does not clear it — hosts retry, so fail → fail → succeed is ordinary, and clearing on success would erase the evidence of the attempts that failed. Read the timestamp before acting on it.

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

## License

Monet is licensed under the **GNU Affero General Public License v3.0** (`AGPL-3.0-only`). Full terms are in the `LICENSE` file included in this package. The `with-monet` harness is licensed separately under the Apache License 2.0.
