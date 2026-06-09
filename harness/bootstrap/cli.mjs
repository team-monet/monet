#!/usr/bin/env node
/**
 * with-monet is installed AGENT-FIRST — you don't run a script, your coding agent does
 * the install by following bootstrap/install.md. This command just prints the one line to
 * paste into your agent (handy if you found the package on npm and aren't sure where to start).
 */
const line = "Set up Monet globally (for all my projects): read https://raw.githubusercontent.com/team-monet/with-monet/main/bootstrap/install.md and follow it, checking with me at each decision point.";
console.log("with-monet — agent-first Monet onboarding\n");
console.log("You don't run an installer. Open your coding agent and paste this one line:\n");
console.log(`  ${line}\n`);
console.log("The agent then follows bootstrap/install.md: orient → get Monet → configure");
console.log("the MCP server → install the team → offer memory ingest → offer to start.");
