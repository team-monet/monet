/**
 * The Task surface's action context (monet-client#56).
 *
 * Task is the only interception in the gated set that is PRE-cognition: every other tool call is
 * late with respect to the agent making it — the approach was chosen and the artifact drafted
 * before the call was formed — while a spawn creates the reasoner the rule governs. Its context is
 * `Task:<subagent_type> <description>` and deliberately excludes the brief's prompt: matching on
 * prompt text would be guessing at what a delegation is about, which is the heuristic interception
 * the boundary statement rejects by name.
 *
 * The wrapper is a generated script, so these tests run it the way Claude Code does — as a real
 * process, over stdin — and read back the action context it hands `monet gate`. The gate itself is
 * replaced by a stub that prints what it received, so nothing here needs a store.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWrapperScript } from "../install-cli";

let dir: string;
let wrapperPath: string;
let capturePath: string;

/** Stands in for `monet gate`: records the action context it was given on stdin, then exits 0 (silence). */
const STUB = `#!/usr/bin/env node
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  require("node:fs").writeFileSync(process.env.CAPTURE_PATH, Buffer.concat(chunks).toString());
  process.exit(0);
});
`;

/** Runs the wrapper exactly as the host does and returns the action context the gate saw. */
function runHook(hookInput: unknown): string | null {
  try {
    execFileSync(process.execPath, [wrapperPath], {
      input: JSON.stringify(hookInput),
      encoding: "utf8",
      // The real wrapper journals every arrival; keep fixture actions out of ~/.monet by default.
      env: { ...process.env, CAPTURE_PATH: capturePath, MONET_STORAGE_DIR: dir },
    });
  } catch {
    // A non-zero exit is still a completed decision path for this test's purposes.
  }
  try {
    return require("node:fs").readFileSync(capturePath, "utf8") as string;
  } catch {
    return null; // the wrapper returned before ever invoking the gate — deliberate silence
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "monet-task-gate-"));
  capturePath = join(dir, "captured.txt");
  const stubPath = join(dir, "gate-stub.cjs");
  writeFileSync(stubPath, STUB);
  chmodSync(stubPath, 0o755);
  wrapperPath = join(dir, "gate-hook.mjs");
  writeFileSync(wrapperPath, buildWrapperScript({ execPath: process.execPath, scriptPath: stubPath }));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Task action context", () => {
  it("is Task:<subagent_type> <description>", () => {
    const ctx = runHook({
      tool_name: "Task",
      tool_input: { subagent_type: "verifier", description: "check the migration path", prompt: "…a long brief…" },
    });
    expect(ctx).toBe("Task:verifier check the migration path");
  });

  // The load-bearing exclusion. A pattern must name a moment, not sniff a payload — and a brief's
  // prompt is where the payload lives.
  it("never carries the brief's prompt", () => {
    const ctx = runHook({
      tool_name: "Task",
      tool_input: { subagent_type: "developer", description: "apply the fix", prompt: "SECRET-CANARY-STRING" },
    });
    expect(ctx).not.toContain("SECRET-CANARY-STRING");
  });

  it("still builds a context when only one of the two fields is present", () => {
    expect(runHook({ tool_name: "Task", tool_input: { subagent_type: "investigator" } })).toBe("Task:investigator");
    expect(runHook({ tool_name: "Task", tool_input: { description: "look into the flake" } })).toBe("Task:look into the flake");
  });

  // Nothing a pattern could match, and an empty context would parse as a bare prefix rather than as
  // a delegation. Silence is the honest outcome, and silence is this design's signal for "no rule
  // governs this" — so it must not be produced by giving up on a malformed input either.
  it("stays silent when neither field is usable", () => {
    expect(runHook({ tool_name: "Task", tool_input: {} })).toBeNull();
    expect(runHook({ tool_name: "Task", tool_input: { subagent_type: "   ", description: "" } })).toBeNull();
    expect(runHook({ tool_name: "Task" })).toBeNull();
  });

  it("leaves Bash exactly as it was", () => {
    expect(runHook({ tool_name: "Bash", tool_input: { command: "git push --force" } })).toBe("Bash:git push --force");
  });

  it("stays silent for every surface outside the gated set", () => {
    expect(runHook({ tool_name: "Write", tool_input: { file_path: "/x", content: "y" } })).toBeNull();
    expect(runHook({ tool_name: "WebFetch", tool_input: { url: "https://example.com" } })).toBeNull();
  });
});

/**
 * The host's name for the delegation tool is a HOST VARIABLE (monet-client#58, 2026-08-03).
 *
 * THE REGRESSION THESE PIN: Claude Code renamed the tool to `Agent`. The guard spelled `"Task"`,
 * so the wrapper returned before spawning the gate — and the delegation surface was
 * invoked-but-inert for months while every observable stayed byte-identical to healthy silence.
 * Measured against cc 2.1.220: the dispatched `tool_name` is `Agent`, and `tool_input` still
 * carries `subagent_type` and `description`, so only the NAME moved.
 *
 * Nothing below asserts an `Agent:` context. That is the point: `Task:` is Monet's canonical
 * spelling for this surface, and every already-declared pattern uses it — a wrapper that faithfully
 * forwarded the host's new name would swap one silent-inert failure for another (gate spawns,
 * matches nothing, looks exactly like healthy silence again).
 */
describe("delegation surface: the host's tool name is a variable", () => {
  it("accepts the host's current name (Agent) and canonicalizes it to Task:", () => {
    const ctx = runHook({
      tool_name: "Agent",
      tool_input: { subagent_type: "verifier", description: "check the migration path", prompt: "…a long brief…" },
    });
    expect(ctx).toBe("Task:verifier check the migration path");
  });

  it("still accepts the host's older name (Task), so a pinned older host keeps its gate", () => {
    expect(runHook({ tool_name: "Task", tool_input: { subagent_type: "developer", description: "apply the fix" } }))
      .toBe("Task:developer apply the fix");
  });

  it("never leaks the brief's prompt on the renamed tool either", () => {
    const ctx = runHook({
      tool_name: "Agent",
      tool_input: { subagent_type: "developer", description: "apply the fix", prompt: "SECRET-CANARY-STRING" },
    });
    expect(ctx).not.toContain("SECRET-CANARY-STRING");
  });

  it("stays silent when the renamed tool carries neither usable field", () => {
    expect(runHook({ tool_name: "Agent", tool_input: {} })).toBeNull();
  });

  // tool_name is untrusted host input reaching an object-literal lookup. A bare index would return
  // a FUNCTION for these — truthy, so the guard would pass and the gate would be handed a context
  // prefixed with a stringified function.
  it("treats inherited Object.prototype keys as ungated, not as surfaces", () => {
    expect(runHook({ tool_name: "constructor", tool_input: { command: "rm -rf /" } })).toBeNull();
    expect(runHook({ tool_name: "toString", tool_input: { command: "rm -rf /" } })).toBeNull();
    expect(runHook({ tool_name: "__proto__", tool_input: { command: "rm -rf /" } })).toBeNull();
  });

  it("stays silent when tool_name is not a string at all", () => {
    expect(runHook({ tool_name: 42, tool_input: { command: "echo hi" } })).toBeNull();
    expect(runHook({ tool_name: null, tool_input: { command: "echo hi" } })).toBeNull();
    expect(runHook({ tool_input: { command: "echo hi" } })).toBeNull();
  });
});
