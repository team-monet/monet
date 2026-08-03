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
      env: { ...process.env, CAPTURE_PATH: capturePath },
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
