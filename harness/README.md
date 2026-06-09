# with-monet

**An agent-agnostic harness that pairs a state-centric coding lead (`Stig`) and a focused worker team with [Monet](https://github.com/team-monet/monet)'s memory substrate.**

The substrate — the `@team-monet/core` engine (in [`team-monet/monet-core`](https://github.com/team-monet/monet-core)) wrapped by the `monet` MCP server + CLI (in [`team-monet/monet`](https://github.com/team-monet/monet), on npm as `@team-monet/monet`) — maintains a coherent, evolving state model — dedup, contradiction detection, session-state survival, query-independent prewarm — so the agent doesn't have to. `with-monet` is the *lightweight* harness that points the coding agent you already use (Claude Code) at that substrate and gives it a team that knows how to use it.

## Where this sits

| Repo | What it is |
|---|---|
| `team-monet/monet` | **Monet** — the local-first client: the `monet` MCP server + CLI (npm `@team-monet/monet`). AGPL-3.0. |
| `team-monet/monet-core` | The **engine** — the state-centric memory substrate (npm `@team-monet/core`). AGPL-3.0. |
| **`with-monet` (this repo)** | The **lightweight, agent-agnostic harness**: portable agent prompts + bootstrap that wire a host to `monet`. |

**`Stig` is a state-centric lead** — the memory discipline (extract → review → commit) is now structural in Monet, so Stig's prompt stays lean and focuses on assembling context for the worker team rather than bookkeeping its own memory.

## The team

- **`stig`** — state-centric lead. Restores via `agent_context` (prewarm), delegates with pre-assembled context, and is the only agent that touches Monet.
- Workers Stig delegates to: `explorer`, `researcher`, `analyst`, `developer`, `tester`, `reviewer`, `security`, `reliability`, `aria`.

## Install — agent-first (paste one line into your agent)

You don't clone this repo or run a script. You open the coding agent you already use, paste **one line**, and the agent installs and configures Monet *for* you — detecting your host, wiring the `monet` MCP server, installing the team, offering to seed memory from your existing docs, then offering to start. It diagnoses and fixes failures interactively, and adapts to your preferences.

Paste into your agent:

> **Set up Monet globally (for all my projects): read https://raw.githubusercontent.com/team-monet/with-monet/main/bootstrap/install.md and follow it, checking with me at each decision point.**

_(Local dev: point at `with-monet/bootstrap/install.md` instead of the URL. The substrate it installs — `monet` — ships on npm as `@team-monet/monet`.)_

The agent then follows the [bootstrap playbook](bootstrap/install.md): **orient → get Monet → configure the MCP server → install the team → offer memory ingest → offer to start.** Why agent-first: the agent already has tools in your environment, so it can install, verify, and recover from failures conversationally — and we can tailor the experience to each user.
