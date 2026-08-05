# with-monet

**An agent-agnostic harness that gives the coding agent you already use durable state through [Monet](https://www.npmjs.com/package/@team-monet/monet), plus disposable contexts (`Stig` and three workers) for the work that would otherwise eat the conversation.**

The substrate — the `monet` MCP server + CLI (available as [`@team-monet/monet`](https://www.npmjs.com/package/@team-monet/monet) on npm) — maintains a persistent memory model so the agent doesn't have to. `with-monet` is the *lightweight* harness that points the coding agent you already use (Claude Code) at that substrate and gives it a team that knows how to use it.

## Where this sits

| Repo | What it is |
|---|---|
| `team-monet/monet` | **Monet** — the local-first client: the `monet` MCP server + CLI (npm `@team-monet/monet`). |
| **`with-monet` (this repo)** | The **lightweight, agent-agnostic harness**: portable agent prompts + bootstrap that wire a host to `monet`. |

## The team

```text
User
  ↕
Stig — the lead: intent, decisions, meaning, continuity
  ↕
Monet — what survives the session
  ├─ investigator — evidence
  ├─ developer    — change
  └─ verifier     — proof
```

**`stig`** is the only persistent agent, the only one the user talks to, the only one that uses Monet, and the only one that delegates. There is no required workflow: Stig answers directly when that suffices and delegates when a fresh isolated context earns its cost.

The three workers are disposable. They hold no memory and own no decisions — each returns a compact artifact of exact evidence, and its context is thrown away. Stig keeps the semantics.

- **`investigator`** — reads the repo, history, logs, docs, or the web, and returns verbatim evidence with its inferences and unknowns kept separate.
- **`developer`** — implements one ratified, bounded change and returns the real diff and the real validation output.
- **`verifier`** — proves or disproves a claim through the lens the brief names: acceptance, runtime, review, security, or a **cold** audit that is deliberately given the change location and nothing else.

Workers can be trimmed, and on a host without a real subagent primitive Stig installs **lead-only** and does the work itself — the Monet loop is unchanged either way.

## Install — agent-first (paste one line into your agent)

You don't clone this repo or run a script. You open the coding agent you already use, paste **one line**, and the agent installs and configures Monet *for* you — detecting your host, wiring the `monet` MCP server, installing the team, offering to seed memory from your existing docs, then offering to start. It diagnoses and fixes failures interactively, and adapts to your preferences.

Paste into your agent:

> **Set up Monet globally (for all my projects): read https://raw.githubusercontent.com/team-monet/with-monet/main/bootstrap/install.md and follow it, checking with me at each decision point.**

_(Local dev: point at `with-monet/bootstrap/install.md` instead of the URL. The substrate it installs — `monet` — ships on npm as `@team-monet/monet`.)_

**Already installed?** To update your existing Monet install, paste:

> **Can you update my Monet installation following https://raw.githubusercontent.com/team-monet/with-monet/main/bootstrap/install.md?**

The agent then follows the [bootstrap playbook](bootstrap/install.md): **orient → get Monet → configure the MCP server → install the team → offer memory ingest → offer to start.** Why agent-first: the agent already has tools in your environment, so it can install, verify, and recover from failures conversationally — and we can tailor the experience to each user.

> ⭐ **Like Monet? [Star this repo](https://github.com/team-monet/with-monet)** to support it — and **Watch → Custom → Releases** to get notified of new versions.
