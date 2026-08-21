/**
 * THE GOVERNED MOMENT, END TO END, THROUGH THE REAL GENERATED WRAPPER.
 *
 * Every other test in this repo reaches the moment record through library calls. This one writes
 * the wrapper `monet install` would install, spawns it with `node`, feeds it the host's own hook
 * JSON on stdin, and lets it spawn the real `monet gate` from `dist/`. It exists because the two
 * defects it pins were both INVISIBLE to library-level tests, and one of them was invisible to a
 * first draft of this file too:
 *
 *   1. THE WRAPPER SELECTS ITS PostToolUse PATH BY AN ARGV MARKER, not by `hook_event_name`. A probe
 *      that sent a PostToolUse payload without `--post-tool-use` silently re-ran the PreToolUse path
 *      and wrote a SECOND interception. Everything downstream looked plausible and measured nothing.
 *
 *   2. WHETHER CONFORMANCE WAS MEASURED AT ALL DEPENDED ON FOLD SCHEDULING. A tool-use-keyed outcome
 *      is deferred to the fold's phase 2b while reads apply in phase 1, so within ONE pass a read
 *      saw `outcome_at` still NULL and was credited, and across TWO passes it saw the outcome and
 *      was discarded. Since the ask signal folds on every successful tool response, any unrelated
 *      MCP call between the tool result and the `stage_lookup` flipped the result. The same session
 *      measured conformance or did not, according to nothing about the session.
 *
 * So both orderings are exercised here and REQUIRED TO AGREE. That agreement is the actual subject.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MonetCore, readGovernedMoment } from "@team-monet/core";
import { buildWrapperScript, POST_TOOL_USE_FLAG } from "../install-cli";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CLI_DIST = join(REPO_ROOT, "dist/cli.js");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const mk = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

interface Rig {
  storageDir: string;
  projectDir: string;
  spool: string;
  dbPath: string;
  mirrorPath: string;
  wrapperPath: string;
}

async function buildRig(): Promise<Rig> {
  const storageDir = mk("monet-e2e-store-");
  const projectDir = mk("monet-e2e-proj-");
  const spool = join(storageDir, "moments.jsonl");
  const dbPath = join(storageDir, "monet.db");
  const mirrorPath = join(storageDir, "gate-mirror.json");

  const core = new MonetCore(dbPath, {
    gateSidecarPath: mirrorPath, defaultCircle: "acme-widgets", momentSpoolPath: spool,
  });
  await core.declare({
    species: "rule", stage: "terraform apply", patterns: ["Bash:terraform apply"],
    content: "Always run plan first.", severity: "advisory", scope: "domain", circle: "acme-widgets",
  });
  await core.declare({
    species: "rule", stage: "git force push", patterns: ["Bash:git push --force"],
    content: "Never force-push to main.", severity: "blocking", scope: "domain",
    reason: "a rewritten history cannot be recovered from a teammate's clone", circle: "acme-widgets",
  });
  core.materializeGateMirror();
  core.close();

  const wrapperPath = join(storageDir, "gate-hook.mjs");
  writeFileSync(wrapperPath, buildWrapperScript({ execPath: process.execPath, scriptPath: CLI_DIST }));
  chmodSync(wrapperPath, 0o755);
  return { storageDir, projectDir, spool, dbPath, mirrorPath, wrapperPath };
}

function hook(rig: Rig, payload: Record<string, unknown>, post = false): { stdout: string } {
  // THE MARKER, NOT THE PAYLOAD, chooses the path — exactly as the installer wires it.
  const args = post
    ? [rig.wrapperPath, "--circle", "acme-widgets", POST_TOOL_USE_FLAG]
    : [rig.wrapperPath, "--circle", "acme-widgets"];
  const r = spawnSync(process.execPath, args, {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, MONET_STORAGE_DIR: rig.storageDir, CLAUDE_PROJECT_DIR: rig.projectDir },
  });
  return { stdout: r.stdout ?? "" };
}

const openCore = (rig: Rig): MonetCore =>
  new MonetCore(rig.dbPath, {
    gateSidecarPath: rig.mirrorPath, defaultCircle: "acme-widgets", momentSpoolPath: rig.spool,
  });

/** What `stage_lookup`'s handler does: look the stage up, then record the read against the moment. */
function agentReadsTheRule(core: MonetCore, stage: string, momentId: string): void {
  const r = core.stageLookup({ stage, circle: "acme-widgets" });
  core.recordRuleReads(momentId, r.rules.map((rule) => rule.conceptId as string), r.stage?.id ?? null, "acme-widgets");
}

/** Runs the advisory path, optionally folding between the outcome and the read. */
async function advisoryRun(foldBetween: boolean): Promise<{
  timely: Record<string, string>; late: Record<string, string>; outcomeAt: string | null; backlog: string[]; readLate: number;
}> {
  const rig = await buildRig();
  const pre = hook(rig, {
    hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: { command: "terraform apply -auto-approve" },
    tool_use_id: "toolu_ADV", session_id: "s1",
  });
  const momentId = (pre.stdout.match(/momentId ([0-9a-f-]{36})/) ?? [])[1];
  expect(momentId, "the advisory must name its moment to the agent").toBeTruthy();

  hook(rig, {
    hook_event_name: "PostToolUse", tool_name: "Bash",
    tool_input: { command: "terraform apply -auto-approve" },
    tool_response: { stdout: "Apply complete!" },
    tool_use_id: "toolu_ADV", session_id: "s1",
  }, true);

  const core = openCore(rig);
  // THE VARIABLE UNDER TEST. Anything that reads moments folds, and the ask signal folds on every
  // successful tool response — so an unrelated MCP call here is the common case, not a corner one.
  if (foldBetween) core.momentCounts();
  agentReadsTheRule(core, "terraform apply", momentId as string);

  const db = (core as unknown as { db: never }).db;
  const row = readGovernedMoment(db, rig.spool, momentId as string);
  const out = {
    timely: row?.ruleReads ?? {},
    late: row?.lateRuleReads ?? {},
    outcomeAt: row?.outcomeAt ?? null,
    backlog: core.momentsOwingAQuestion(10),
    readLate: core.momentConformance().readLate,
  };
  core.close();
  return out;
}

describe("governed moment, end to end through the real wrapper", () => {
  it("classifies an advisory's late read identically however many fold passes it takes", async () => {
    const inOnePass = await advisoryRun(false);
    const acrossTwo = await advisoryRun(true);

    // THE POINT OF THIS TEST. Before the fix these two disagreed completely: one credited the read
    // and queued the moment for a question, the other silently discarded the read.
    expect(Object.keys(inOnePass.late)).toHaveLength(1);
    expect(Object.keys(acrossTwo.late)).toHaveLength(1);
    expect(Object.keys(inOnePass.timely)).toEqual([]);
    expect(Object.keys(acrossTwo.timely)).toEqual([]);
    expect(inOnePass.backlog).toEqual(acrossTwo.backlog);
    expect(inOnePass.readLate).toBe(acrossTwo.readLate);
  }, 120_000);

  it("records the advisory's read as late rather than discarding it, and never as receipt", async () => {
    const r = await advisoryRun(false);
    // On this host the advisory reaches the model beside the tool result, so the lookup it prompts
    // cannot precede the act. Fact 3 is correctly false — and the read still happened.
    expect(r.outcomeAt).not.toBeNull();
    expect(Object.keys(r.late)).toHaveLength(1);
    expect(Object.values(r.late)[0] > (r.outcomeAt as string)).toBe(true);
    expect(r.timely).toEqual({});
    // Unjudgeable, so it owes no question — but it is NOT invisible.
    expect(r.backlog).toEqual([]);
    expect(r.readLate).toBe(1);
  }, 120_000);

  it("joins a deny's read as timely, and leaves it outcomeless because the action never ran", async () => {
    const rig = await buildRig();
    const pre = hook(rig, {
      hook_event_name: "PreToolUse", tool_name: "Bash",
      tool_input: { command: "git push --force origin main" },
      tool_use_id: "toolu_DENY", session_id: "s1",
    });
    expect(pre.stdout).toContain('"permissionDecision":"deny"');
    const momentId = (pre.stdout.match(/momentId ([0-9a-f-]{36})/) ?? [])[1];
    expect(momentId).toBeTruthy();
    // A denied action does not run, so the host fires no closing event. None is sent.

    const core = openCore(rig);
    agentReadsTheRule(core, "git force push", momentId as string);
    const db = (core as unknown as { db: never }).db;
    const row = readGovernedMoment(db, rig.spool, momentId as string);

    expect(row?.disposition).toBe("blocked");
    // RECEIVED IS GENUINELY TRUE HERE — the deny lands before the action, so this read is timely.
    expect(Object.keys(row?.ruleReads ?? {})).toHaveLength(1);
    expect(row?.lateRuleReads).toEqual({});
    // And Conformed is unreachable anyway: no action ran, so no outcome ever arrives, and the
    // retry opens a different moment with no link back. Tracked as its own issue, not a bug here.
    expect(row?.outcomeAt).toBeNull();
    expect(core.momentsOwingAQuestion(10)).toEqual([]);
    core.close();
  }, 120_000);

  it("records under a project-local store whose home directory does not exist", async () => {
    const rig = await buildRig();
    // The spool's parent is created on demand; before this it failed ENOENT into a silent catch
    // and every read reported the ordinary pre-first-append state.
    const missing = join(rig.storageDir, "does", "not", "exist");
    const r = spawnSync(process.execPath, [rig.wrapperPath, "--circle", "acme-widgets"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse", tool_name: "Bash",
        tool_input: { command: "terraform apply -auto-approve" },
        tool_use_id: "toolu_NEST", session_id: "s1",
      }),
      encoding: "utf8",
      env: { ...process.env, MONET_STORAGE_DIR: missing, CLAUDE_PROJECT_DIR: rig.projectDir },
    });
    expect(r.status).toBe(0);
    const spooled = readFileSync(join(missing, "moments.jsonl"), "utf8")
      .split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as { kind: string });
    expect(spooled.some((x) => x.kind === "interception")).toBe(true);
  }, 120_000);

  it("records a wrapper-written outcome under a storage home that does not exist", async () => {
    const rig = await buildRig();
    // BOTH WRITERS NEED THE DIRECTORY, and they are different code paths: the interception above is
    // written by `monet gate` through core's own append, while the outcome below is written by the
    // WRAPPER's copy of it. A test that only covered the gate would leave the wrapper's half
    // unproven -- the copies move together, so both are exercised.
    const missing = join(rig.storageDir, "no", "such", "home");
    const r = spawnSync(process.execPath, [rig.wrapperPath, "--circle", "acme-widgets", POST_TOOL_USE_FLAG], {
      input: JSON.stringify({
        hook_event_name: "PostToolUse", tool_name: "Bash",
        tool_input: { command: "terraform apply -auto-approve" },
        tool_response: { stdout: "Apply complete!" },
        tool_use_id: "toolu_ORPHAN", session_id: "s1",
      }),
      encoding: "utf8",
      env: { ...process.env, MONET_STORAGE_DIR: missing, CLAUDE_PROJECT_DIR: rig.projectDir },
    });
    expect(r.status).toBe(0);
    const spooled = readFileSync(join(missing, "moments.jsonl"), "utf8")
      .split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as { kind: string });
    expect(spooled.some((x) => x.kind === "outcome")).toBe(true);
  }, 120_000);
});
