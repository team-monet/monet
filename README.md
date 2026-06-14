# Monet

**Local-first, state-centric memory for coding agents.**

Monet gives the coding agent you already use a memory that persists across sessions — it maintains a structured model of your project (decisions, conventions, gotchas, and how they connect) instead of hoarding transcripts. It runs **100% on your machine** — on-device embeddings, no network calls, no telemetry, your data never leaves your laptop — and speaks **MCP**, so it works with the agents and editors you already have.

## Get started — let your agent set it up

Paste this one line into your coding agent:

> **Set up Monet for all my projects: read https://raw.githubusercontent.com/team-monet/with-monet/main/bootstrap/install.md and follow it, checking with me at each step.**

Your agent installs Monet, wires up the MCP server, and pulls in a memory-aware agent team — no manual config, no environment variables. That's the **[with-monet](https://github.com/team-monet/with-monet)** harness, and it's the recommended path.

Prefer to wire it yourself? The package is on npm:

```sh
npx @team-monet/monet
```

## Where to go

|  |  |
|---|---|
| 🧰 **Harness, docs & install** | **[github.com/team-monet/with-monet](https://github.com/team-monet/with-monet)** |
| 📦 **Package** | **[npmjs.com/package/@team-monet/monet](https://www.npmjs.com/package/@team-monet/monet)** |

> ⭐ If Monet helps, **[star with-monet](https://github.com/team-monet/with-monet)** — it's the best way to support the project.

## License

Monet is **free to use** for any purpose, personal or commercial, under the Monet Software License. Redistribution as a standalone product, modification, and reverse-engineering are not permitted. Full terms ship with the npm package.
