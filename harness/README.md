# with-monet

**An agent-agnostic harness that pairs a product owner with strong technical understanding (`Stig`) and a focused engineering team with [Monet](https://www.npmjs.com/package/@team-monet/monet)'s memory substrate.**

The substrate — the `monet` MCP server + CLI (available as [`@team-monet/monet`](https://www.npmjs.com/package/@team-monet/monet) on npm) — maintains a persistent memory model so the agent doesn't have to. `with-monet` is the *lightweight* harness that points the coding agent you already use (Claude Code) at that substrate and gives it a team that knows how to use it.

## Where this sits

| Repo | What it is |
|---|---|
| `team-monet/monet` | **Monet** — the local-first client: the `monet` MCP server + CLI (npm `@team-monet/monet`). |
| **`with-monet` (this repo)** | The **lightweight, agent-agnostic harness**: portable agent prompts + bootstrap that wire a host to `monet`. |

**`Stig` is the product owner** — it learns how the product should work, makes routine priority/scope/disposition decisions, and turns technical evidence into the smallest adequate product response. Monet, context assembly, delegation, and verification support that judgment; they are not Stig's identity.

## The team

- **`stig`** — product owner and lead. Owns routine product judgment inside the ratified model, returns new direction or meaningful contract/priority/scope changes to the user, delegates with focused context, and is the only agent that touches Monet.
- Workers Stig delegates to: `explorer`, `researcher`, `analyst`, `mechanic`, `developer`, `tester`, `reviewer`, `auditor`, `security`.

## Install — agent-first (paste one line into your agent)

You don't clone this repo or run a script. You open the coding agent you already use, paste **one line**, and the agent installs and configures Monet *for* you — detecting your host, wiring the `monet` MCP server, installing the team, offering to seed memory from your existing docs, then offering to start. It diagnoses and fixes failures interactively, and adapts to your preferences.

Paste into your agent:

> **Set up Monet globally (for all my projects): read https://raw.githubusercontent.com/team-monet/with-monet/main/bootstrap/install.md and follow it, checking with me at each decision point.**

_(Local dev: point at `with-monet/bootstrap/install.md` instead of the URL. The substrate it installs — `monet` — ships on npm as `@team-monet/monet`.)_

**Already installed?** To update your existing Monet install, paste:

> **Can you update my Monet installation following https://raw.githubusercontent.com/team-monet/with-monet/main/bootstrap/install.md?**

The agent then follows the [bootstrap playbook](bootstrap/install.md): **orient → get Monet → configure the MCP server → install the team → offer memory ingest → offer to start.** Why agent-first: the agent already has tools in your environment, so it can install, verify, and recover from failures conversationally — and we can tailor the experience to each user.

> ⭐ **Like Monet? [Star this repo](https://github.com/team-monet/with-monet)** to support it — and **Watch → Custom → Releases** to get notified of new versions.
