import { describe, it, expect } from "vitest";
import { generateAgentConfig, toYaml } from "../config-cli";

// A representative resolved project dir — distinct from process.cwd() so tests can tell
// MONET_PROJECT_DIR (pinned from the argument) apart from MONET_STORAGE_DIR (derived from cwd).
const PROJECT_DIR = "/Users/example/code/some-repo";
// The RESOLVED storage dir (as cli.ts passes from getMonetDir()) — pinned verbatim, never recomputed.
const STORAGE_DIR = "/Users/example/.monet";

describe("generateAgentConfig", () => {
  it("claude-code: emits mcpServers.monet WITHOUT MONET_PROJECT_DIR — Claude Code supplies CLAUDE_PROJECT_DIR per project, and pinning would break globally-installed configs", () => {
    const config = generateAgentConfig("claude-code", PROJECT_DIR, STORAGE_DIR) as {
      mcpServers: { monet: { command: string; args: string[]; env: Record<string, string> } };
    };
    expect(config.mcpServers.monet.command).toBe("monet");
    expect(config.mcpServers.monet.args).toEqual(["start"]);
    expect(config.mcpServers.monet.env).not.toHaveProperty("MONET_PROJECT_DIR");
    expect(config.mcpServers.monet.env.MONET_STORAGE_DIR).toBe(STORAGE_DIR);
  });

  it("cursor: emits mcp_servers.Monet with MONET_PROJECT_DIR pinned", () => {
    const config = generateAgentConfig("cursor", PROJECT_DIR, STORAGE_DIR) as {
      mcp_servers: { Monet: { env: Record<string, string> } };
    };
    expect(config.mcp_servers.Monet.env.MONET_PROJECT_DIR).toBe(PROJECT_DIR);
  });

  it("hermes: emits mcp_servers.monet with MONET_PROJECT_DIR pinned", () => {
    const config = generateAgentConfig("hermes", PROJECT_DIR, STORAGE_DIR) as {
      mcp_servers: { monet: { env: Record<string, string> } };
    };
    expect(config.mcp_servers.monet.env.MONET_PROJECT_DIR).toBe(PROJECT_DIR);
  });

  it("openclaw: emits the bare server object with MONET_PROJECT_DIR pinned", () => {
    const config = generateAgentConfig("openclaw", PROJECT_DIR, STORAGE_DIR) as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    expect(config.command).toBe("monet");
    expect(config.args).toEqual(["start"]);
    expect(config.env.MONET_PROJECT_DIR).toBe(PROJECT_DIR);
  });

  it("unknown agent type falls back to the bare server object with MONET_PROJECT_DIR pinned", () => {
    const config = generateAgentConfig("some-future-host", PROJECT_DIR, STORAGE_DIR) as { env: Record<string, string> };
    expect(config.env.MONET_PROJECT_DIR).toBe(PROJECT_DIR);
  });

  it("pins whatever projectDir it's given — different callers get different MONET_PROJECT_DIR (non-claude-code hosts)", () => {
    const a = generateAgentConfig("cursor", "/path/a", STORAGE_DIR) as { mcp_servers: { Monet: { env: Record<string, string> } } };
    const b = generateAgentConfig("cursor", "/path/b", STORAGE_DIR) as { mcp_servers: { Monet: { env: Record<string, string> } } };
    expect(a.mcp_servers.Monet.env.MONET_PROJECT_DIR).toBe("/path/a");
    expect(b.mcp_servers.Monet.env.MONET_PROJECT_DIR).toBe("/path/b");
  });

  it("omits MONET_CALLER_ID / MONET_PROJECT_ID when no identity overrides are passed", () => {
    const config = generateAgentConfig("claude-code", PROJECT_DIR, STORAGE_DIR) as {
      mcpServers: { monet: { env: Record<string, string> } };
    };
    expect(config.mcpServers.monet.env).not.toHaveProperty("MONET_CALLER_ID");
    expect(config.mcpServers.monet.env).not.toHaveProperty("MONET_PROJECT_ID");
  });

  it("pins explicit identity overrides into the emitted env — including for claude-code, where an explicit override is deliberate", () => {
    const config = generateAgentConfig("claude-code", PROJECT_DIR, STORAGE_DIR, {
      callerId: "ci-runner",
      projectId: "github.com/acme/widgets",
    }) as { mcpServers: { monet: { env: Record<string, string> } } };
    expect(config.mcpServers.monet.env.MONET_CALLER_ID).toBe("ci-runner");
    expect(config.mcpServers.monet.env.MONET_PROJECT_ID).toBe("github.com/acme/widgets");
  });

  it("pins a single override independently — the other key stays omitted", () => {
    const config = generateAgentConfig("openclaw", PROJECT_DIR, STORAGE_DIR, { callerId: "ci-runner" }) as {
      env: Record<string, string>;
    };
    expect(config.env.MONET_CALLER_ID).toBe("ci-runner");
    expect(config.env).not.toHaveProperty("MONET_PROJECT_ID");
  });
});

describe("toYaml", () => {
  it("renders a generated config as YAML, including the pinned MONET_PROJECT_DIR", () => {
    const config = generateAgentConfig("hermes", PROJECT_DIR, STORAGE_DIR);
    const yaml = toYaml(config);
    expect(yaml).toContain(`MONET_PROJECT_DIR: ${PROJECT_DIR}`);
  });
});
