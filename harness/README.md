# with-monet

**An agent-agnostic harness that pairs a state-centric coding lead (`Stig`) and a focused worker team with [Monet Local](https://github.com/team-monet/monet)'s memory substrate.**

The substrate (`@monet/core` + `monet-local`, in the `team-monet/monet` repo) maintains a coherent, evolving state model — dedup, contradiction detection, session-state survival, query-independent prewarm — so the agent doesn't have to. `with-monet` is the *lightweight* harness that points whatever coding agent you run (Claude Code today; Cursor, Continue, … next) at that substrate and gives it a team that knows how to use it.

## Where this sits

| Repo | What it is |
|---|---|
| `team-monet/monet` | The substrate + server: `monet-core` engine, `monet-local` MCP server, API, dashboard. Host-agnostic. |
| **`with-monet` (this repo)** | The **lightweight, agent-agnostic harness**: portable agent prompts + bootstrap that wire a host to `monet-local`. |

**`Stig` is rewritten to the new state-centric substrate** — the old `EXTRACT → REVIEW → COMMIT → REBUILD` memory discipline is now structural in Monet (ADR 0001 §7), so Stig's prompt shrank. The worker prompts are being generalized away from OpenCode specifics.

## The team

- **`stig`** — state-centric lead. Restores via `agent_context` (prewarm), delegates with pre-assembled context, and is the only agent that touches Monet.
- Workers Stig delegates to: `explorer`, `researcher`, `analyst`, `developer`, `tester`, `reviewer`, `security`, `reliability`, `aria`.

## Install — agent-first (paste one line into your agent)

You don't clone this repo or run a script. You open the coding agent you already use, paste **one line**, and the agent installs and configures Monet *for* you — detecting your host, wiring the `monet-local` MCP server, installing the team, offering to seed memory from your existing docs, then offering to start. It diagnoses and fixes failures interactively, and adapts to your preferences.

Paste into your agent:

> **Set up Monet for this project: read https://raw.githubusercontent.com/team-monet/with-monet/main/bootstrap/install.md and follow it, checking with me at each decision point.**

_(Local dev: point at `with-monet/bootstrap/install.md` instead of the URL. The substrate it installs — `monet-local` — ships on npm as `@team-monet/local`.)_

The agent then follows the [bootstrap playbook](bootstrap/install.md): **orient → get Monet Local → configure the MCP server → install the team → offer memory ingest → offer to start.** Why agent-first: the agent already has tools in your environment, so it can install, verify, and recover from failures conversationally — and we can tailor the experience to each user.

## Roadmap

- [x] Substrate published to npm (`@team-monet/local`) — `npm i -g @team-monet/local`.
- [ ] Push `with-monet` so the one-line entry resolves (raw `install.md` URL).
- [ ] Broaden the playbook's per-host coverage beyond Claude Code (Cursor, Continue, Aider).
- [ ] Memory-ingest recipes (old Monet export, `CLAUDE.md`/`docs`).
- [ ] Finish generalizing the worker prompts off OpenCode.
