# Monet

**Memory should change what your agent does.**

Monet is local-first memory for coding agents, built for one thing: the outcome you meant. It keeps what you and your team actually want — principles, rules, corrections — and delivers it **while the agent works**: principles always in front of it, rules read at the moment they bind (commit, release, delegate, PR), corrections recorded so they never need making twice. MCP-native, 100% on your machine.

## Get started — let your agent set it up

Paste this one line into Claude Code (more agents coming soon):

> **Set up Monet for all my projects: read https://raw.githubusercontent.com/team-monet/monet/main/harness/bootstrap/install.md and follow it, checking with me at each step.**

Your agent installs Monet, wires up the MCP server, and brings the working method — restore state at session start, read the rules when moments arrive, record what you correct. That's the **with-monet** harness in [`harness/`](./harness), and it's the recommended path.

Prefer to wire it yourself? The package is on npm:

```sh
npx @team-monet/monet
```

## Yours — and verifiably so

- One store at `~/.monet` — plain SQLite you can read, back up, export.
- Embeddings run on-device. No accounts, no API keys, no cloud.
- Works offline after the first model download.

## Where to go

|  |  |
|---|---|
| 🏠 **Homepage** | **[team-monet.com](https://team-monet.com)** |
| 🧰 **Harness, docs & install** | **[`harness/`](./harness)** |
| 📦 **Package** | **[npmjs.com/package/@team-monet/monet](https://www.npmjs.com/package/@team-monet/monet)** |

> ⭐ If Monet helps, **[star the repo](https://github.com/team-monet/monet)** — it's the best way to support the project.

## What's in this repo

| Path | What it is |
|---|---|
| `packages/core` | The memory engine — store, retrieval, gates. Bundled into the CLI rather than published on its own. |
| `packages/cli` | The `monet` MCP server + CLI. This is what ships to npm as `@team-monet/monet`. |
| `harness/` | The `with-monet` agent harness — agent prompts and the install playbook. Markdown and one CLI stub; not a workspace member. |

Building and testing: [CONTRIBUTING.md](./CONTRIBUTING.md). Reporting a vulnerability: [SECURITY.md](./SECURITY.md).

## License

`packages/core` and `packages/cli` are licensed under the **GNU Affero General Public License v3.0** (`AGPL-3.0-only`) — see [LICENSE](./LICENSE). `harness/` is licensed under the **Apache License 2.0** — see [harness/LICENSE](./harness/LICENSE).
