# Security Policy

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting: open the **Security** tab on this repository and choose **Report a vulnerability**. That opens an advisory visible only to you and the maintainers.

**Please do not open a public issue, discussion, or pull request for a vulnerability.** Those are visible to everyone, including people who would use the report before a fix exists.

**We do not promise a response time.** This is a small project, and no one is currently staffed to guarantee an acknowledgement window. Reports are read and acted on as maintainer time allows. If you need a committed turnaround, we would rather tell you plainly that we cannot offer one than publish a deadline nobody holds.

## What to include

- What an attacker can do, and what they need in order to do it — local shell access? a crafted file? a hostile MCP client?
- Steps to reproduce.
- The version (`monet --version`) or the commit, and your OS.

## The shape of the attack surface

Monet is local-first. It runs on the user's machine with the user's privileges; there is no Monet server and no Monet account. The interesting boundaries are therefore local ones:

- **It reads the user's files.** Registered Markdown sources point at real directories and Git repositories, and the agent-driven install reads and writes agent configuration files.
- **It runs an MCP server.** Any MCP client configured to reach it can call its tools. `monet dashboard` additionally serves a read-only HTTP view, bound to `127.0.0.1`.
- **It stores data in SQLite**, by default at `~/.monet`. That database holds whatever the user's agent has written — in practice, private notes and project detail.
- **It clones and reads Git repositories** for managed sources, using the SSH agent the Monet process inherits.

Findings that are squarely in scope: path traversal out of a registered source; anything that lets one circle read another's memory; anything that makes the dashboard write, or serve beyond loopback; credentials leaking into a stored remote URL; a tool call that escapes the store's boundaries.

## By design, not a vulnerability

The `~/.monet` database is readable by the machine's own user. That is deliberate — it is plain SQLite the user can read, back up, and export, and it is their data on their disk.
