import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { MonetCore } from "@team-monet/core";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalRemoteKey, deriveCircle } from "../circle";
import { GATE_FAIL_OPEN_MARKER } from "../gate-cli";
import {
  atomicWriteFile,
  buildCoverageReport,
  buildWrapperScript,
  isMonetGateHandler,
  runInstall,
  upsertMonetGateHook,
  GATED_TOOL_MATCHERS,
  type HookHandler,
  type InstallCliDependencies,
  type SettingsFile,
} from "../install-cli";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CLI_ENTRY = join(REPO_ROOT, "src/cli.ts");
const TSX_LOADER = join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs");

// Every test below that merely needs to FIND the groups this command writes follows the constant
// rather than re-typing its values; the one test that pins the literal strings is the contract test
// ("gates the Bash and delegation surfaces, and nothing else"). Re-typing them everywhere is how a
// matcher change turns into a dozen unrelated-looking failures that get "fixed" by search-replace.
const [BASH_MATCHER, DELEGATION_MATCHER] = GATED_TOOL_MATCHERS;

/** Declaration-1-shaped fixture, matching gate-cli.test.ts's own — a global blocking deny. */
async function buildFixtureMirror(mirrorPath: string, circle = "*"): Promise<void> {
  const core = new MonetCore(":memory:", { gateSidecarPath: mirrorPath, defaultCircle: "acme-widgets" });
  await core.declare({
    species: "rule", stage: "git force push", patterns: ["Bash:git push --force"],
    content: "Never force-push to main.", severity: "blocking", scope: "domain",
    reason: "a rewritten history cannot be recovered from a teammate's clone",
    circle,
  });
  core.materializeGateMirror();
  core.close();
}

/** Claude Code's own PreToolUse hook JSON shape (fetched from https://code.claude.com/docs/en/hooks
 *  for this slice — see install-cli.ts's own module comment for the full citation). */
function claudeCodeHookJson(command: string): string {
  return JSON.stringify({
    session_id: "test-session",
    prompt_id: "test-prompt",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/tmp",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "toolu_test",
  });
}

function fakeDeps(overrides: Partial<InstallCliDependencies> = {}): InstallCliDependencies {
  return {
    homeDir: () => "/should-not-be-used",
    projectDir: () => "/should-not-be-used",
    deriveCircle: () => "should-not-be-used",
    monetInvocation: () => ({ execPath: "/usr/bin/node", scriptPath: "/opt/monet/dist/cli.js" }),
    ensureMonetDir: () => "/should-not-be-used/.monet",
    setExitCode: () => {},
    ...overrides,
  };
}

describe("install-cli: settings.json shapes (pure, no fs)", () => {
  it("isMonetGateHandler: matches the FULL resolved wrapper path, in exec-form (args[0]) or shell-form (command substring)", () => {
    const wrapperPath = "/home/x/.monet/gate-hook.mjs";
    // Exec form (what THIS version of runInstall writes): args[0] is the wrapper path exactly.
    expect(isMonetGateHandler({ type: "command", command: "/usr/bin/node", args: [wrapperPath] }, wrapperPath)).toBe(true);
    expect(isMonetGateHandler({ type: "command", command: "/usr/bin/node", args: [wrapperPath, "--circle", "acme"] }, wrapperPath)).toBe(true);
    // Shell form (what an OLDER, pre-round-5 install wrote) — full path still findable as a substring.
    expect(isMonetGateHandler({ type: "command", command: `/usr/bin/node '${wrapperPath}'` }, wrapperPath)).toBe(true);
    expect(isMonetGateHandler({ type: "command", command: `/usr/bin/node '${wrapperPath}' --circle 'acme'` }, wrapperPath)).toBe(true);
    // SHOULD-FIX 1's own proof (round-5 coordinator review): a DIFFERENT file that merely SHARES
    // the bare filename, in some other directory, must NOT match — the old bare-filename
    // substring check deleted exactly this kind of foreign, unrelated hook.
    expect(isMonetGateHandler({ type: "command", command: "/usr/bin/node /home/someone/my-own-scripts/gate-hook.mjs" }, wrapperPath)).toBe(false);
    expect(isMonetGateHandler({ type: "command", command: "/usr/bin/node", args: ["/home/someone/my-own-scripts/gate-hook.mjs"] }, wrapperPath)).toBe(false);
    expect(isMonetGateHandler({ type: "command", command: "./some-other-script.sh" }, wrapperPath)).toBe(false);
    expect(isMonetGateHandler({ type: "http", url: "http://example.com" }, wrapperPath)).toBe(false);
    expect(isMonetGateHandler(null, wrapperPath)).toBe(false);
    expect(isMonetGateHandler("a string", wrapperPath)).toBe(false);
  });

  it("upsertMonetGateHook: adds fresh matcher groups for every gated surface when none exist", () => {
    const wrapperPath = "/x/.monet/gate-hook.mjs";
    const handler: HookHandler = { type: "command", command: "/usr/bin/node", args: [wrapperPath] };
    const result = upsertMonetGateHook({}, handler, wrapperPath);
    expect(result.hooks?.PreToolUse).toEqual([
      { matcher: BASH_MATCHER, hooks: [handler] },
      { matcher: DELEGATION_MATCHER, hooks: [handler] },
    ]);
  });

  // The list is short on purpose (monet-client#56). Every other tool is post-cognition — the agent
  // has already decided by the time the call is formed — and high-frequency; delegation is in
  // because a spawn creates the reasoner the rule governs.
  //
  // The exact STRINGS are pinned here, not derived, so that changing them is a deliberate act with
  // a test to update. Each is load-bearing and each was measured against cc 2.1.220 (see
  // GATED_TOOL_MATCHERS' own comment): matchers are regexes; the delegation matcher must name
  // `Agent` outright rather than trusting the host's `Task` alias to survive; both spellings must
  // sit in ONE group, because two groups that both match fire both their handlers; and both are
  // anchored so `Bash` cannot substring-match `BashOutput`.
  it("upsertMonetGateHook: gates the Bash and delegation surfaces, and nothing else", () => {
    expect([...GATED_TOOL_MATCHERS]).toEqual(["^Bash$", "^(Task|Agent)$"]);
  });

  /**
   * THE UPGRADE PATH every already-installed machine takes, and the specific way it could go wrong.
   *
   * A pre-patch install left literal `Bash` and `Task` groups holding this command's handler. If
   * re-installing merely ADDED the new groups, the stale `Task` group would keep its live handler
   * alongside the new `^(Task|Agent)$` group — and since BOTH match an `Agent` dispatch (measured,
   * cc 2.1.220), every delegation would spawn the gate twice, inject any advisory twice, and write
   * two journal lines per deny. The strip-then-add order is what prevents that, so it is asserted
   * rather than assumed: the old groups must be GONE, not merely joined.
   */
  it("upsertMonetGateHook: upgrading from the pre-patch literal `Bash`/`Task` groups leaves no stale group behind", () => {
    const wrapperPath = "/x/.monet/gate-hook.mjs";
    const installed: HookHandler = { type: "command", command: "/usr/bin/node", args: [wrapperPath] };
    const settings: SettingsFile = {
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [installed] }, { matcher: "Task", hooks: [installed] }] },
    };
    const result = upsertMonetGateHook(settings, installed, wrapperPath);
    expect(result.hooks?.PreToolUse).toEqual([
      { matcher: BASH_MATCHER, hooks: [installed] },
      { matcher: DELEGATION_MATCHER, hooks: [installed] },
    ]);
    // Said twice on purpose: the assertion above already implies it, but THIS is the property that
    // fails loudly if the strip step ever regresses to an additive upsert.
    const matchers = (result.hooks?.PreToolUse ?? []).map((g) => g.matcher);
    expect(matchers).not.toContain("Task");
    expect(matchers).not.toContain("Bash");
  });

  // The same upgrade, but the user had their OWN handler sharing the old `Bash` group. Their group
  // survives (it still holds their handler); only ours is stripped out of it. No monet handler is
  // left in a group that would double-match, which is the property that actually matters.
  it("upsertMonetGateHook: upgrading past a pre-patch group that ALSO held a foreign handler keeps theirs and moves only ours", () => {
    const wrapperPath = "/x/.monet/gate-hook.mjs";
    const installed: HookHandler = { type: "command", command: "/usr/bin/node", args: [wrapperPath] };
    const foreign: HookHandler = { type: "command", command: "./their-own-check.sh" };
    const settings: SettingsFile = {
      hooks: { PreToolUse: [{ matcher: "Task", hooks: [foreign, installed] }] },
    };
    const result = upsertMonetGateHook(settings, installed, wrapperPath);
    expect(result.hooks?.PreToolUse).toEqual([
      { matcher: "Task", hooks: [foreign] }, // theirs, untouched, ours removed
      { matcher: BASH_MATCHER, hooks: [installed] },
      { matcher: DELEGATION_MATCHER, hooks: [installed] },
    ]);
  });

  it("upsertMonetGateHook: reuses an existing Bash group, preserving any OTHER handler already in it", () => {
    const wrapperPath = "/x/.monet/gate-hook.mjs";
    const preexisting: HookHandler = { type: "command", command: "./unrelated-check.sh" };
    const settings: SettingsFile = { hooks: { PreToolUse: [{ matcher: BASH_MATCHER, hooks: [preexisting] }] } };
    const handler: HookHandler = { type: "command", command: "/usr/bin/node", args: [wrapperPath] };
    const result = upsertMonetGateHook(settings, handler, wrapperPath);
    expect(result.hooks?.PreToolUse).toEqual([
      { matcher: BASH_MATCHER, hooks: [preexisting, handler] },
      { matcher: DELEGATION_MATCHER, hooks: [handler] },
    ]);
  });

  it("upsertMonetGateHook: idempotent — updates its own prior entry in place, never duplicates", () => {
    const wrapperPath = "/x/.monet/gate-hook.mjs";
    const oldHandler: HookHandler = { type: "command", command: "/usr/bin/node", args: [wrapperPath, "--circle", "old-circle"] };
    const settings: SettingsFile = { hooks: { PreToolUse: [{ matcher: BASH_MATCHER, hooks: [oldHandler] }] } };
    const newHandler: HookHandler = { type: "command", command: "/usr/bin/node", args: [wrapperPath, "--circle", "new-circle"] };
    const result = upsertMonetGateHook(settings, newHandler, wrapperPath);
    expect(result.hooks?.PreToolUse).toEqual([
      { matcher: BASH_MATCHER, hooks: [newHandler] },
      { matcher: DELEGATION_MATCHER, hooks: [newHandler] },
    ]);
  });

  it("upsertMonetGateHook: never touches an UNRELATED matcher group or event", () => {
    const wrapperPath = "/x/.monet/gate-hook.mjs";
    const settings: SettingsFile = {
      hooks: {
        PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "./format-check.sh" }] }],
        PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./log-it.sh" }] }],
      },
      someOtherTopLevelKey: "preserved verbatim",
    };
    const handler: HookHandler = { type: "command", command: "/usr/bin/node", args: [wrapperPath] };
    const result = upsertMonetGateHook(settings, handler, wrapperPath);
    expect(result.hooks?.PreToolUse).toEqual([
      { matcher: "Write|Edit", hooks: [{ type: "command", command: "./format-check.sh" }] },
      { matcher: BASH_MATCHER, hooks: [handler] },
      { matcher: DELEGATION_MATCHER, hooks: [handler] },
    ]);
    expect((result.hooks as Record<string, unknown>).PostToolUse).toEqual(settings.hooks!.PostToolUse);
    expect(result.someOtherTopLevelKey).toBe("preserved verbatim");
  });

  it("upsertMonetGateHook: removing the only handler from a group drops the now-empty group, not left dangling", () => {
    const wrapperPath = "/x/.monet/gate-hook.mjs";
    const oldHandler: HookHandler = { type: "command", command: "/usr/bin/node", args: [wrapperPath] };
    const settings: SettingsFile = {
      hooks: {
        PreToolUse: [
          { matcher: BASH_MATCHER, hooks: [oldHandler] },
          { matcher: "Write", hooks: [{ type: "command", command: "./other.sh" }] },
        ],
      },
    };
    const newHandler: HookHandler = { type: "command", command: "/usr/bin/node", args: [wrapperPath, "--circle", "x"] };
    // Simulate a scope change where the fresh handler lands in a NEW group rather than reusing
    // the old "Bash" one — upsertMonetGateHook still must not leave a dangling empty "Bash" group
    // if some other path stripped it down to zero survivors. Exercised directly here by giving it
    // an already-Bash-matched settings object and confirming no empty group survives regardless.
    const result = upsertMonetGateHook(settings, newHandler, wrapperPath);
    const groups = result.hooks?.PreToolUse ?? [];
    expect(groups.every((g) => g.hooks.length > 0)).toBe(true);
    expect(groups.find((g) => g.matcher === "Write")).toBeDefined();
  });

  it("upsertMonetGateHook: preserves a matcher group that was ALREADY empty before this function ever touched it (NIT, round-5 coordinator review)", () => {
    const wrapperPath = "/x/.monet/gate-hook.mjs";
    // The user's OWN pre-existing empty group — nothing to do with Monet. The old code's
    // `survivors.length > 0` check alone could not tell this apart from "we just emptied it out
    // ourselves", and silently deleted it either way.
    const settings: SettingsFile = { hooks: { PreToolUse: [{ matcher: "Write", hooks: [] }] } };
    const handler: HookHandler = { type: "command", command: "/usr/bin/node", args: [wrapperPath] };
    const result = upsertMonetGateHook(settings, handler, wrapperPath);
    const writeGroup = result.hooks?.PreToolUse?.find((g) => g.matcher === "Write");
    expect(writeGroup).toEqual({ matcher: "Write", hooks: [] }); // preserved exactly, not dropped
    const bashGroup = result.hooks?.PreToolUse?.find((g) => g.matcher === BASH_MATCHER);
    expect(bashGroup?.hooks).toEqual([handler]);
  });

  it("upsertMonetGateHook: does not mutate its input (safe for a --dry-run caller to compute and discard)", () => {
    const wrapperPath = "/x/.monet/gate-hook.mjs";
    const settings: SettingsFile = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] } };
    const before = JSON.stringify(settings);
    upsertMonetGateHook(settings, { type: "command", command: "/usr/bin/node", args: [wrapperPath] }, wrapperPath);
    expect(JSON.stringify(settings)).toBe(before);
  });

  it("buildCoverageReport: names the interleaved-args caveat with the concrete example and guidance", () => {
    const report = buildCoverageReport();
    expect(report).toContain("git push origin main --force");
    expect(report).toContain("Declare the orderings");
    expect(report).toContain("you fear as separate patterns");
    expect(report.toLowerCase()).toContain("sh -c");
    expect(report).toContain("Cursor");
  });
});

describe("install-cli: buildWrapperScript", () => {
  it("bakes in the exact monet invocation and forwards its own argv to `monet gate --stdin`", () => {
    const script = buildWrapperScript({ execPath: "/usr/bin/node", scriptPath: "/opt/monet/dist/cli.js" });
    expect(script).toContain('"/usr/bin/node"');
    expect(script).toContain('"/opt/monet/dist/cli.js"');
    expect(script).toContain('"gate", "--stdin"');
    // P1-3 (Codex round 3 on PR #42): --tool Bash is GONE — the wrapper now builds the fully
    // prefixed context itself rather than relying on gate-cli's own --tool synthesis, which a
    // prefix-grammar-shaped command could silently bypass. See main()'s own comment (right above
    // `const actionContext = surface + ":" + command;`) for the full bypass this closes, and the
    // dedicated P1-3 rehearsal test below for the actual exploit reproduced.
    //
    // CORRECTED (host-tool-name patch): this assertion used to read `"Bash:" + command`, which
    // matched only the PROSE of the comment above that line — the code itself has never said that
    // — so it would have kept passing through any rewrite of the expression it claims to pin.
    // It now names the actual statement.
    expect(script).not.toContain('"--tool", "Bash"');
    expect(script).toContain('const actionContext = surface + ":" + command;');
    expect(script).toContain('"deny"');
    expect(script).toContain('"ask"');
    expect(script).toContain("additionalContext");
    expect(script).toContain("gate-denies.log");
    expect(script).toContain("0o600");
    // BLOCKER 1 (round-5 coordinator review, hooks.md:148): the wrapper must never CONSTRUCT
    // permissionDecision:"defer" — the real proof is the end-to-end rehearsal tests below (which
    // parse the actual stdout the wrapper emits), but this catches a source-level regression too.
    // "defer" itself still appears in this file's own explanatory comments (quoting the doc to
    // explain why it is the WRONG value), so this checks the exact object-literal shape, not the
    // bare substring.
    expect(script).not.toContain('permissionDecision: "defer"');
    expect(script).not.toContain("deferSilently");
  });
});

describe("install-cli: end-to-end hook rehearsal (the wrapper script actually run)", () => {
  // CORRECTED CONTRACT (round-5 coordinator review): a real `claude -p` rehearsal — actually
  // observing whether "defer" pauses/exits a live session — is out of reach for a unit test suite
  // (it needs a running Claude Code process and a --resume round trip). What IS tested here is
  // the wrapper's ACTUAL JSON SHAPE against the doc quotes this file's own comments cite: empty
  // stdout + exit 0 for every non-blocking outcome (hooks.md:148), additionalContext with NO
  // permissionDecision key for advisory (hooks.md:764, :1542, :820-829), and deny/ask unchanged.
  const dirs: string[] = [];
  const mkTmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "monet-install-cli-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Every real wrapper journals before it decides; this helper owns the default storage isolation so
  // a new rehearsal cannot silently append fixture actions to the developer's live ~/.monet journal.
  function spawnWrapper(
    wrapperPath: string,
    args: string[],
    dir: string,
    options: Parameters<typeof spawnSync>[2] & { encoding?: BufferEncoding | "buffer" | null } = {},
  ): ReturnType<typeof spawnSync> & { stdout: string; stderr: string } {
    return spawnSync(process.execPath, [wrapperPath, ...args], {
      encoding: "utf8",
      ...options,
      env: options.env ?? { ...process.env, MONET_STORAGE_DIR: dir },
    }) as ReturnType<typeof spawnSync> & { stdout: string; stderr: string };
  }

  function writeRealWrapper(dir: string): string {
    // The REAL monet invocation this repo's own tests use elsewhere (tsx against src/cli.ts) —
    // the actual command a hook would run, not a stand-in.
    const script = buildWrapperScript({ execPath: process.execPath, scriptPath: CLI_ENTRY });
    // Splice in the loader flag this repo's own tests need to run TS directly (see gate-cli.test.ts's
    // own TSX_LOADER comment) — the REAL install target is a built dist/cli.js needing no loader at
    // all; this is the one adaptation the rehearsal makes for running against source instead of a
    // build, and it changes nothing about the JSON the wrapper reads or emits. Targets the PRIMARY
    // spawnSync call only (MONET_EXEC/MONET_SCRIPT) — the round-5 PATH-fallback call (bare "monet")
    // is a separate, untouched call site, matching production behavior exactly.
    const withLoader = script.replace(
      "const MONET_EXEC = ",
      `const NODE_LOADER_ARGS = ["--import", ${JSON.stringify(TSX_LOADER)}];\nconst MONET_EXEC = `,
    ).replace(
      "[MONET_SCRIPT, ...gateArgs]",
      "[...NODE_LOADER_ARGS, MONET_SCRIPT, ...gateArgs]",
    );
    const wrapperPath = join(dir, "gate-hook.mjs");
    writeFileSync(wrapperPath, withLoader, { mode: 0o755 });
    return wrapperPath;
  }

  it("deny reaches the wrapper's own stdout in the protocol's deny shape, with the reason", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const wrapperPath = writeRealWrapper(dir);

    // MONET_STORAGE_DIR isolates the deny journal into this test's own tmp dir. Without it, this
    // very test appended one REAL line to ~/.monet/gate-denies.log on every suite run — found as
    // 13 synthetic lines in the live journal during the round-5 integration pass. The wrapper
    // resolves the journal at run time (env first, home fallback) precisely so tests can do this.
    const result = spawnWrapper(wrapperPath, ["--mirror", mirrorPath], dir, {
      encoding: "utf8",
      input: claudeCodeHookJson("git push --force"),
      env: { ...process.env, MONET_STORAGE_DIR: dir },
    });
    expect(result.status).toBe(0); // the WRAPPER always exits 0 — the decision rides the JSON
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
      systemMessage: string;
    };
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
      "a rewritten history cannot be recovered from a teammate's clone",
    );
    // Boundary statement item 4: surfaces on the USER's channel too, not only the agent's.
    expect(output.systemMessage).toContain("a rewritten history cannot be recovered from a teammate's clone");
    // The journal line landed in the ISOLATED dir — asserted here so the isolation is load-bearing,
    // not decorative. (The HOME-fallback rung is covered by the dedicated "deny journal" test.)
    const journal = readFileSync(join(dir, "gate-denies.log"), "utf8");
    expect(journal).toContain("a rewritten history cannot be recovered from a teammate's clone");
  });

  it("P2-8 (Codex round 3 on PR #42): the deny's systemMessage carries BOTH the reason AND monet gate's own stderr diagnostics (the mirror's age, the repair instruction) — not the reason alone", async () => {
    // Before this fix: monet gate's own stderr (resolved circle, mirror age, repair command) was
    // captured in `result` all along but silently dropped — a user blocked by a STALE cached deny
    // never saw the staleness or the repair command unless they separately ran `monet gate` by
    // hand. The boundary statement's own recoverability promise is only real if it reaches the
    // person actually blocked.
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const wrapperPath = writeRealWrapper(dir);

    const result = spawnWrapper(wrapperPath, ["--mirror", mirrorPath], dir, {
      encoding: "utf8",
      input: claudeCodeHookJson("git push --force"),
      env: { ...process.env, MONET_STORAGE_DIR: dir },
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
      systemMessage: string;
    };
    // The reason is still there (unchanged) ...
    expect(output.systemMessage).toContain("a rewritten history cannot be recovered from a teammate's clone");
    // ... AND now the staleness/repair diagnostic rides alongside it, on the SAME systemMessage a
    // user actually sees — this is the fix. permissionDecisionReason (the AGENT's channel) stays
    // reason-only, unchanged from before.
    expect(output.systemMessage).toContain("monet gate: answering from a mirror generated");
    expect(output.systemMessage).toContain("monet start");
    expect(output.hookSpecificOutput.permissionDecisionReason).not.toContain("monet gate: answering from a mirror generated");
    // Reason comes FIRST, diagnostics after — matches "append... after the reason".
    const reasonIndex = output.systemMessage.indexOf("a rewritten history cannot be recovered");
    const diagnosticIndex = output.systemMessage.indexOf("monet gate: answering from a mirror generated");
    expect(reasonIndex).toBeGreaterThanOrEqual(0);
    expect(diagnosticIndex).toBeGreaterThan(reasonIndex);
  });

  it("P1-3 (Codex round 3 on PR #42): the exact Codex bypass example ('x: || true; git push --force') still DENIES — the wrapper no longer relies on --tool synthesis a prefix-grammar command can defeat", async () => {
    // THE BYPASS: bash runs the force-push after the harmless "x: command not found" failure, but
    // the RAW text "x: || true; git push --force" itself parses as tool "x" (parseActionContext
    // sees the leading "x:" as a Tool: prefix) — before this fix, the wrapper piped this raw text
    // in and relied on --tool Bash to synthesize a "Bash:" prefix, but gate-cli's own
    // ensureToolPrefixedContext ONLY synthesizes when the context has NO parseable prefix already
    // — so --tool Bash was silently ignored, the context evaluated as tool "x", and EVERY
    // Bash-scoped rule (including the force-push deny this fixture declares) silently failed to
    // match. FAILS BEFORE THE FIX: this exact input previously produced empty stdout (silence) —
    // see this round's own report for the git-show-swapped before/after run.
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const wrapperPath = writeRealWrapper(dir);

    const result = spawnWrapper(wrapperPath, ["--mirror", mirrorPath], dir, {
      encoding: "utf8",
      input: claudeCodeHookJson("x: || true; git push --force"),
      env: { ...process.env, MONET_STORAGE_DIR: dir }, // a deny fires below — isolate the journal
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toContain(
      "a rewritten history cannot be recovered from a teammate's clone",
    );
  });

  it("a command matching no rule (force-with-lease) produces EMPTY stdout and exit 0 — normal permission flow decides, not Monet", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const wrapperPath = writeRealWrapper(dir);

    const result = spawnWrapper(wrapperPath, ["--mirror", mirrorPath], dir, {
      encoding: "utf8",
      input: claudeCodeHookJson("git push --force-with-lease"),
    });
    expect(result.status).toBe(0);
    // BLOCKER 1 (round-5 coordinator review, hooks.md:148): "Exit code 0 with no output means the
    // hook has no decision to report, so the tool call continues through the normal permission
    // flow." NOT permissionDecision:"defer" — hooks.md:1576-1577/:1581 show that value is ignored
    // in interactive sessions and EXITS THE ENTIRE `claude -p` process in non-interactive ones.
    expect(result.stdout).toBe("");
  });

  it("an advisory-only fire carries additionalContext with NO permissionDecision key (injected, never blocking)", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    const core = new MonetCore(":memory:", { gateSidecarPath: mirrorPath, defaultCircle: "acme-widgets" });
    await core.declare({
      species: "rule", stage: "terraform apply", patterns: ["Bash:terraform apply"],
      content: "Always run plan first.", severity: "advisory", scope: "domain", circle: "acme-widgets",
    });
    core.materializeGateMirror();
    core.close();
    const wrapperPath = writeRealWrapper(dir);

    const result = spawnWrapper(wrapperPath, ["--circle", "acme-widgets", "--mirror", mirrorPath], dir, {
      encoding: "utf8",
      input: claudeCodeHookJson("terraform apply"),
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string; permissionDecision?: string };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(output.hookSpecificOutput.additionalContext).toContain("Always run plan first");
    // BLOCKER 2 (round-5 coordinator review, hooks.md:1542): additionalContext is "Ignored when
    // permissionDecision is 'defer'" — pairing the two made this outcome a silent no-op under the
    // old code. permissionDecision must be genuinely ABSENT here, not merely falsy.
    expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect("permissionDecision" in output.hookSpecificOutput).toBe(false);
  });

  it("overflow-ask maps to the protocol's ask value, never allow or deny", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const wrapperPath = writeRealWrapper(dir);

    const over = "x".repeat(5 * 1024 * 1024);
    const result = spawnWrapper(wrapperPath, ["--circle", "acme-widgets", "--mirror", mirrorPath], dir, {
      encoding: "utf8",
      input: claudeCodeHookJson(over),
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecision: string } };
    expect(output.hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("P1-A (Codex round 4 on PR #42): an envelope past the wrapper's own RETAINED_STDIN_CAP_BYTES cap short-circuits to \"ask\" — never a silent pass-through for a monster command (fails before this fix: empty stdout, exit 0)", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const wrapperPath = writeRealWrapper(dir);

    // 17 MiB of command content pushes the WHOLE JSON envelope (command plus the small fixed
    // envelope fields claudeCodeHookJson adds) past the wrapper's own 16 MiB RETAINED_STDIN_CAP_BYTES.
    // readAllStdin() truncates mid-string (the command string alone dominates the total size, so
    // the cut lands inside it regardless of field order) — JSON.parse throws on the unterminated
    // string. `monet gate` is NEVER SPAWNED for this case: the wrapper cannot extract a command
    // from JSON it cannot parse at all, so it must decide from the truncation signal alone (see
    // main()'s own comment for the full reasoning) — this is a DIFFERENT code path than the
    // "overflow-ask maps to..." test just above, where the envelope parses FINE and it is `monet
    // gate` itself (spawned successfully) that reports exit 40 for an over-threshold COMMAND.
    const over = "x".repeat(17 * 1024 * 1024);
    const result = spawnWrapper(wrapperPath, ["--circle", "acme-widgets", "--mirror", mirrorPath], dir, {
      encoding: "utf8",
      input: claudeCodeHookJson(over),
    });
    expect(result.status).toBe(0); // the wrapper always exits 0 — the decision rides the JSON
    expect(result.stdout).not.toBe(""); // BEFORE this fix: empty — the bare `catch { return; }`
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
      systemMessage: string;
    };
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(output.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain("too large");
    expect(output.systemMessage).toContain("too large");
  });

  it("malformed hook input (not JSON) produces empty stdout and exit 0, never crashes", () => {
    const dir = mkTmp();
    const wrapperPath = writeRealWrapper(dir);
    const result = spawnWrapper(wrapperPath, [], dir, { encoding: "utf8", input: "not json at all" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("a non-Bash tool_name produces empty stdout and exit 0 (defense in depth — the settings matcher is already Bash-only)", () => {
    const dir = mkTmp();
    const wrapperPath = writeRealWrapper(dir);
    const result = spawnWrapper(wrapperPath, [], dir, {
      encoding: "utf8",
      input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/tmp/x" } }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("a Bash tool_input with no .command string produces empty stdout and exit 0", () => {
    const dir = mkTmp();
    const wrapperPath = writeRealWrapper(dir);
    const result = spawnWrapper(wrapperPath, [], dir, {
      encoding: "utf8",
      input: JSON.stringify({ tool_name: "Bash", tool_input: { not_command: "echo hi" } }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("SHOULD-FIX 3: a spawn failure (stale baked-in paths, PATH fallback also failing) emits a systemMessage with NO permissionDecision, exit 0", () => {
    const dir = mkTmp();
    // Deliberately bogus paths — simulates the baked-in monetInvocation() going stale (e.g. an
    // nvm reinstall moved or removed the node/monet paths recorded at `monet install` time).
    const script = buildWrapperScript({
      execPath: join(dir, "nonexistent-node-binary"),
      scriptPath: join(dir, "nonexistent-cli.js"),
    });
    const wrapperPath = join(dir, "gate-hook.mjs");
    writeFileSync(wrapperPath, script, { mode: 0o755 });

    const result = spawnWrapper(wrapperPath, [], dir, {
      encoding: "utf8",
      input: claudeCodeHookJson("echo hello"),
      // Strip PATH so the round-5 PATH-fallback (`spawnSync("monet", ...)`) ALSO fails to
      // resolve — proving this reaches emitSpawnFailureWarning rather than silently succeeding
      // via a real `monet` this test machine happens to have installed.
      env: { ...process.env, MONET_STORAGE_DIR: dir, PATH: join(dir, "empty-path-for-testing") },
    });
    expect(result.status).toBe(0); // still fail OPEN — never block because the HOOK is broken
    const output = JSON.parse(result.stdout) as {
      systemMessage?: string;
      hookSpecificOutput?: { permissionDecision?: string };
    };
    expect(output.systemMessage).toContain("could not get an answer from `monet gate`");
    expect(output.systemMessage).toContain("monet install");
    // No permissionDecision anywhere — a broken hook must never force allow/deny/ask.
    expect(output.hookSpecificOutput).toBeUndefined();
  });

  it("RECHECK: an OLDER monet on PATH (spawns fine, exits 1 — no gate command) is as loud as no monet at all", () => {
    // The recheck reviewer reproduced this against a real pre-gate global install: the SF3 PATH
    // fallback spawns it successfully, it answers `unknown command 'gate'` with exit 1, and the
    // old switch lumped exit 1 into the silent default — turning the stale-install scenario SF3
    // exists to make LOUD back into a silent, permanent no-gate on exactly the machines most
    // likely to hit it (any machine with an older global monet).
    const dir = mkTmp();
    const script = buildWrapperScript({
      execPath: join(dir, "nonexistent-node-binary"),
      scriptPath: join(dir, "nonexistent-cli.js"),
    });
    const wrapperPath = join(dir, "gate-hook.mjs");
    writeFileSync(wrapperPath, script, { mode: 0o755 });
    // A stub `monet` on PATH that mimics the pre-gate CLI: prints the usage error, exits 1.
    const stubBin = join(dir, "stub-bin");
    mkdirSync(stubBin, { recursive: true });
    writeFileSync(join(stubBin, "monet"), `#!/bin/sh\necho "monet source: unknown command 'gate'" >&2\nexit 1\n`, { mode: 0o755 });

    const result = spawnWrapper(wrapperPath, [], dir, {
      encoding: "utf8",
      input: claudeCodeHookJson("echo hello"),
      env: { ...process.env, MONET_STORAGE_DIR: dir, PATH: stubBin },
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      systemMessage?: string;
      hookSpecificOutput?: { permissionDecision?: string };
    };
    expect(output.systemMessage).toContain("predates the gate command");
    expect(output.systemMessage).toContain("monet install");
    expect(output.hookSpecificOutput).toBeUndefined();
  });

  it("FIX 2 (Codex round 2 on PR #42): a deny whose stdout exceeds spawnSync's ~1 MiB DEFAULT maxBuffer is still preserved, not lost to a silent spawn-failure downgrade", () => {
    // The "fakegate" pattern: a fake \`monet gate\` that ALWAYS emits well over 1 MiB of stdout
    // (spawnSync's own default maxBuffer) and exits 30 (deny), regardless of its input — proving
    // the WRAPPER's own spawnSync call (not the real CLI, which is declaration-length-capped and
    // would never naturally produce output this large) actually raised its maxBuffer rather than
    // silently truncating/ENOBUFS-ing on a large legitimate deny.
    const dir = mkTmp();
    const hugeReason = "x".repeat(2 * 1024 * 1024); // 2 MiB — comfortably past the 1 MiB default
    const fakeGatePath = join(dir, "fakegate.mjs");
    // process.exitCode (NOT process.exit()) — a large stdout.write() to a pipe is asynchronous;
    // calling process.exit() immediately after it can terminate the process before the OS pipe
    // buffer (commonly 64 KiB) has fully drained, TRUNCATING the very output this test exists to
    // prove survives intact. Setting exitCode and letting node exit naturally once its event loop
    // drains waits for the pending write to complete first — a fakegate-script bug caught by this
    // test's own first run, not a defect in the fix under test.
    writeFileSync(
      fakeGatePath,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`Blocked: ${hugeReason}`)});\nprocess.exitCode = 30;\n`,
      { mode: 0o755 },
    );
    const script = buildWrapperScript({ execPath: process.execPath, scriptPath: fakeGatePath });
    const wrapperPath = join(dir, "gate-hook.mjs");
    writeFileSync(wrapperPath, script, { mode: 0o755 });

    // This is a DENY (exit 30) — the wrapper's own appendDenyLine fires. Isolate HOME so that
    // journal write lands in this test's own tmp dir, never the real ~/.monet/gate-denies.log
    // (see this file's deny-journal test above for the established convention).
    const fakeHome = mkTmp();
    const result = spawnWrapper(wrapperPath, [], dir, {
      encoding: "utf8",
      input: claudeCodeHookJson("echo hello"),
      maxBuffer: 32 * 1024 * 1024, // this OUTER spawnSync (test harness → wrapper) also needs headroom
      env: { ...process.env, HOME: fakeHome },
    });
    expect(result.status).toBe(0); // the wrapper itself always exits 0
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      systemMessage?: string;
    };
    // THE FIX: still a real deny, not a spawn-failure downgrade (which would show up as
    // systemMessage-only, no hookSpecificOutput — see the SF3/RECHECK tests above for that shape).
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toContain(hugeReason);
    expect(output.systemMessage).toContain(hugeReason);
  });

  it("P1-A (Codex round 1 on PR #42): a missing mirror — the fresh-install state every new user passes through — surfaces monet gate's own fail-open diagnostic as systemMessage, still no permissionDecision", () => {
    const dir = mkTmp();
    const wrapperPath = writeRealWrapper(dir);
    // Never created — exactly a fresh `monet install` where no `monet start` session has EVER
    // run yet to materialize the mirror.
    const missingMirrorPath = join(dir, "never-materialized", "gate-mirror.json");

    const result = spawnWrapper(wrapperPath, ["--mirror", missingMirrorPath], dir, {
      encoding: "utf8",
      input: claudeCodeHookJson("echo hello"),
    });
    expect(result.status).toBe(0); // fail OPEN — still never blocks because THIS is unevaluated
    const output = JSON.parse(result.stdout) as {
      systemMessage?: string;
      hookSpecificOutput?: { permissionDecision?: string };
    };
    expect(output.systemMessage).toBeDefined();
    expect(output.systemMessage).toContain(GATE_FAIL_OPEN_MARKER);
    // The fresh-install repair advice (gate-cli.ts's own reworded message) rides along verbatim.
    expect(output.systemMessage).toContain("monet start");
    expect(output.systemMessage).toContain("fresh `monet install`");
    // No permissionDecision anywhere — a missing mirror is still "Monet has no opinion", just a
    // LOUD no-opinion instead of a silent one.
    expect(output.hookSpecificOutput).toBeUndefined();
  });

  it("P1-A: a healthy mirror answering genuine silence stays COMPLETELY empty — the marker must not false-positive on the ordinary circle diagnostic line", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);

    // PROVE THE PREMISE FIRST, directly against `monet gate` itself (not through the wrapper —
    // the wrapper never forwards the INNER gate process's stderr to its OWN stderr; it only greps
    // that captured stderr internally for the marker, then speaks JSON on stdout or stays silent).
    // A healthy mirror answering silence still prints a real, non-empty "circle X (resolved from
    // Y)" diagnostic line (gate-cli.ts's own describeResolvedCircle) — confirming that line does
    // NOT itself contain the fail-open marker is what makes the wrapper-level assertion below mean
    // something, rather than trivially passing because there was nothing to false-positive on.
    const directResult = spawnSync(
      process.execPath,
      ["--import", TSX_LOADER, "src/cli.ts", "gate", "Bash:echo hello, this matches no declared rule at all", "--mirror", mirrorPath],
      { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, MONET_STORAGE_DIR: dir } },
    );
    expect(directResult.status).toBe(0);
    expect(directResult.stderr).toContain("circle");
    expect(directResult.stderr).not.toContain(GATE_FAIL_OPEN_MARKER);
    expect(directResult.stdout).toBe("");

    // NOW THE WRAPPER: same scenario, through the generated hook script — must stay completely
    // silent on stdout, exactly as before this fix (this fix only ADDS detection on the fail-open
    // path; it must not start emitting on the ordinary, nothing-to-report path).
    const wrapperPath = writeRealWrapper(dir);
    const result = spawnWrapper(wrapperPath, ["--mirror", mirrorPath], dir, {
      encoding: "utf8",
      input: claudeCodeHookJson("echo hello, this matches no declared rule at all"),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("P1-A: GATE_FAIL_OPEN_MARKER is load-bearing — the bare literal appears ONLY at its own definition in gate-cli.ts, every fail-open message references the constant", () => {
    expect(GATE_FAIL_OPEN_MARKER).toBe("failing OPEN");

    const gateCliSource = readFileSync(join(REPO_ROOT, "src/gate-cli.ts"), "utf8");
    const bareLiteralLines = gateCliSource.split("\n").filter((line) => line.includes('"failing OPEN"'));
    // Exactly one occurrence: the constant's own `export const GATE_FAIL_OPEN_MARKER = "failing
    // OPEN"` declaration. If a NEW fail-open message were ever added by hand-typing the literal
    // instead of interpolating the constant, this assertion catches it — a decorative constant
    // sitting unused beside hardcoded prose would pass a bare "is it exported" check but fail this.
    expect(bareLiteralLines).toHaveLength(1);
    expect(bareLiteralLines[0]).toContain("GATE_FAIL_OPEN_MARKER =");

    const interpolationCount = (gateCliSource.match(/\$\{GATE_FAIL_OPEN_MARKER\}/g) ?? []).length;
    expect(interpolationCount).toBeGreaterThanOrEqual(3); // the 3 fail-open sites this fix threads through it

    // The wrapper bakes the SAME literal in at GENERATION time (not a re-typed copy) — see
    // buildWrapperScript's own comment.
    const script = buildWrapperScript({ execPath: "/usr/bin/node", scriptPath: "/opt/monet/dist/cli.js" });
    expect(script).toContain(JSON.stringify(GATE_FAIL_OPEN_MARKER));
  });

  it("deny journal: appends ONE 0600 line on a real deny", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    // This test covers the HOME-FALLBACK rung of the wrapper's journal resolution
    // (MONET_STORAGE_DIR || join(homedir(), ".monet")): fake homedir via HOME — os.homedir() reads
    // $HOME on POSIX — and strip MONET_STORAGE_DIR from the child env so an outer environment that
    // happens to set it cannot short-circuit the rung under test.
    const fakeHome = mkTmp();
    mkdirSync(join(fakeHome, ".monet"), { recursive: true });
    const wrapperPath = writeRealWrapper(dir);
    const { MONET_STORAGE_DIR: _stripped, ...envWithoutStorageDir } = process.env;

    const result = spawnWrapper(wrapperPath, ["--mirror", mirrorPath], dir, {
      encoding: "utf8",
      input: claudeCodeHookJson("git push --force"),
      env: { ...envWithoutStorageDir, HOME: fakeHome },
    });
    expect(result.status).toBe(0);

    const logPath = join(fakeHome, ".monet", "gate-denies.log");
    expect(existsSync(logPath)).toBe(true);
    const mode = statSync(logPath).mode & 0o777;
    expect(mode).toBe(0o600);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\t/); // ISO timestamp first
    expect(lines[0]).toContain("Never force-push to main");

    // A second deny appends a SECOND line — never overwrites.
    spawnWrapper(wrapperPath, ["--mirror", mirrorPath], dir, {
      encoding: "utf8",
      input: claudeCodeHookJson("git push --force"),
      env: { ...envWithoutStorageDir, HOME: fakeHome },
    });
    expect(readFileSync(logPath, "utf8").trim().split("\n")).toHaveLength(2);
  });

  /**
   * THE REGRESSION TEST FOR monet-client#58 — the whole chain, no stubs: a rule declared against a
   * `Task:` pattern, dispatched under the host's CURRENT tool name (`Agent`), evaluated by the real
   * `monet gate` against a real mirror.
   *
   * This is the test whose absence let the delegation surface sit invoked-but-inert for months. The
   * unit-level context tests (task-gate-context.test.ts) pin the wrapper's canonicalization against
   * a gate STUB; only this one proves the canonical spelling is the one the engine actually matches
   * — which is the entire reason `Agent` maps to the surface named `Task` rather than to itself.
   */
  it("monet-client#58: a Task:-declared rule DENIES a delegation the host dispatches as `Agent`", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    const core = new MonetCore(":memory:", { gateSidecarPath: mirrorPath, defaultCircle: "acme-widgets" });
    await core.declare({
      species: "rule", stage: "worker delegation", patterns: ["Task:verifier"],
      content: "Never delegate verification without naming the lens.",
      severity: "blocking", scope: "domain",
      reason: "an unlensed verification returns agreement, not proof",
      circle: "*",
    });
    core.materializeGateMirror();
    core.close();
    const wrapperPath = writeRealWrapper(dir);

    const dispatch = (toolName: string) => spawnWrapper(wrapperPath, ["--mirror", mirrorPath], dir, {
      encoding: "utf8",
      input: JSON.stringify({
        session_id: "s", transcript_path: "/tmp/t.jsonl", cwd: "/tmp", hook_event_name: "PreToolUse",
        tool_name: toolName,
        // Verbatim shape observed from cc 2.1.220: only the tool NAME moved in the rename.
        tool_input: { subagent_type: "verifier", description: "confirm the fix", prompt: "…brief…", run_in_background: false },
      }),
      env: { ...process.env, MONET_STORAGE_DIR: dir },
    });

    for (const hostToolName of ["Agent", "Task"]) {
      const result = dispatch(hostToolName);
      expect(result.status).toBe(0); // the wrapper always exits 0 — the decision rides the JSON
      // BEFORE THE PATCH this stdout was EMPTY for "Agent" — byte-identical to "no rule governs
      // this", which is exactly why nothing surfaced for months.
      expect(result.stdout, `host tool name ${hostToolName} produced no decision`).not.toBe("");
      const output = JSON.parse(result.stdout) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
      };
      expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
        "an unlensed verification returns agreement, not proof",
      );
    }
  });

  /**
   * THE GATE JOURNAL, END TO END — `normative-hierarchy-2026-08-03.md` §1/§5.
   *
   * Two mouths write one stream: the hook records what the HOOK did, the gate records what the GATE
   * did. Neither is redundant, and that is the point — when they disagree, or when one exists
   * without the other, THAT is the finding. Collapsing them into a single event would rebuild the
   * "one observable for three states" defect this whole design exists to remove.
   */
  it("gate journal: an interception writes both mouths' events, correlated, with the rule ids that fired", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const wrapperPath = writeRealWrapper(dir);

    const result = spawnWrapper(wrapperPath, ["--mirror", mirrorPath], dir, {
      encoding: "utf8",
      input: claudeCodeHookJson("git push --force"),
      env: { ...process.env, MONET_STORAGE_DIR: dir },
    });
    expect(result.status).toBe(0);

    const lines = readFileSync(join(dir, "gate-journal.jsonl"), "utf8")
      .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);

    const hook = lines.filter((l) => l.mouth === "host-hook");
    const gate = lines.filter((l) => l.mouth === "gate-cli");
    expect(hook).toHaveLength(2); // arrival + disposition
    expect(gate).toHaveLength(2);

    // The correlation: the gate the hook spawned names the hook's event as its parent. This is what
    // makes "the hook arrived but the gate never evaluated" a query rather than an inference.
    expect(gate[0].parentId).toBe(hook[0].id);
    expect(gate[0].phase).toBe("arrival");
    expect(gate[1].phase).toBe("disposition");

    // Both agree on the verdict, from their own vantage points.
    expect(hook[1].disposition).toBe("deny");
    expect(gate[1].disposition).toBe("deny");
    // Rule identity — the thing gate_events has never carried, and #62's whole query.
    expect(Array.isArray(gate[1].ruleIds) && (gate[1].ruleIds as string[]).length).toBe(1);
    // A mirror answer is true as of a frozen generation, not as of the store. Typed honestly.
    expect(gate[1].claimType).toBe("parsed");
    expect(hook[1].claimType).toBe("source-observed");
  });

  /**
   * THE §0 EVENT, AND ITS ABSENCE OF A SIBLING.
   *
   * This is the exact incident the design is an answer to, now leaving a trace: a tool_name the
   * guard does not recognize. The hook declines — correctly, it is not a gated surface — and the
   * gate is never spawned. So the journal shows a hook event with `declined: foreign-tool` and NO
   * gate-cli event at all, which is precisely the shape a months-dark surface would have had.
   */
  it("gate journal: a foreign tool_name is recorded as a decline, and the gate leaves no event because it never ran", () => {
    const dir = mkTmp();
    const wrapperPath = writeRealWrapper(dir);

    const result = spawnWrapper(wrapperPath, [], dir, {
      encoding: "utf8",
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "SomeToolTheHostRenamed", tool_input: { command: "x" } }),
      env: { ...process.env, MONET_STORAGE_DIR: dir },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(""); // the agent-facing signal is unchanged: still silence

    const lines = readFileSync(join(dir, "gate-journal.jsonl"), "utf8")
      .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(lines.filter((l) => l.mouth === "gate-cli")).toHaveLength(0); // never spawned
    const hook = lines.filter((l) => l.mouth === "host-hook");
    expect(hook).toHaveLength(2);
    expect(hook[1].disposition).toBe("declined: foreign-tool");
    // Recorded verbatim and unmapped: the question this answers months later is "what did the host
    // actually call it", and any normalization here would destroy the only evidence of a rename.
    expect(hook[1].hostToolName).toBe("SomeToolTheHostRenamed");
  });

  /**
   * CODEX P2 ON PR #63, and it was right on both counts. Two ways this journal was quietly lying
   * about the very ambiguity it exists to remove.
   */
  it("gate journal: an unrecognized gate exit code is declined, never written down as silence", () => {
    const dir = mkTmp();
    // A gate that exits 7 — not one of the five documented outcomes. The wrapper still fails open;
    // what must change is that the RECORD stops claiming a healthy evaluation happened.
    const stubPath = join(dir, "gate-7.cjs");
    writeFileSync(stubPath, '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>process.exit(7));\n');
    const wrapperPath = join(dir, "gate-hook.mjs");
    writeFileSync(wrapperPath, buildWrapperScript({ execPath: process.execPath, scriptPath: stubPath }), { mode: 0o755 });

    const result = spawnSync(process.execPath, [wrapperPath], {
      encoding: "utf8",
      input: claudeCodeHookJson("echo hi"),
      env: { ...process.env, MONET_STORAGE_DIR: dir },
    });
    expect(result.stdout).toBe(""); // fail-open is unchanged

    const lines = readFileSync(join(dir, "gate-journal.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const disposition = lines[1]!;
    expect(disposition.disposition).toBe("declined: gate-unknown-status");
    expect(disposition.claimType).toBe("unavailable"); // never a verdict about an evaluation we did not see
    expect(disposition.gateExitCode).toBe(7);
  });

  // The arrival must be on disk BEFORE stdin is read, not merely before it is parsed: reading is
  // where a monster payload exhausts memory and where a stalled producer never sends EOF, and those
  // are exactly the failures a two-phase journal exists to make visible.
  it("gate journal: the arrival is written before stdin is read", () => {
    const dir = mkTmp();
    const wrapperPath = writeRealWrapper(dir);
    spawnSync(process.execPath, [wrapperPath], {
      encoding: "utf8",
      input: claudeCodeHookJson("echo hi"),
      env: { ...process.env, MONET_STORAGE_DIR: dir },
    });
    // Filtered by mouth: the real gate this spawns journals into the SAME stream, so the raw line
    // order interleaves two mouths' events.
    const hook = readFileSync(join(dir, "gate-journal.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.mouth === "host-hook");
    // Nothing about the payload can be on the arrival line, because nothing had been read yet.
    expect(hook[0]!.phase).toBe("arrival");
    expect(hook[0]!.stdinBytes).toBeUndefined();
    // It lands on the disposition, where it is actually known.
    expect(hook[1]!.stdinBytes).toBeGreaterThan(0);
  });

  // CODEX P2 ON PR #63: a MONET_STORAGE_DIR that does not exist yet made every append throw into a
  // swallowing catch — silently, and precisely on a fresh install or a direct gate call before the
  // store was initialised. The first invocations are the ones a record most needs to have. (Hit for
  // real during development, which is how the swallow got noticed at all.)
  it("gate journal: creates the configured storage directory rather than losing the first events", () => {
    const dir = join(mkTmp(), "deep", "nested", "never-created");
    const wrapperPath = writeRealWrapper(mkTmp());
    spawnSync(process.execPath, [wrapperPath], {
      encoding: "utf8",
      input: claudeCodeHookJson("echo hi"),
      env: { ...process.env, MONET_STORAGE_DIR: dir },
    });
    expect(existsSync(join(dir, "gate-journal.jsonl"))).toBe(true);
  });

  // Silence is still silence to the agent — and now it is an EVENT, so its absence means something.
  it("gate journal: an ungoverned command produces no agent-facing signal and a full pair of events", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const wrapperPath = writeRealWrapper(dir);

    const result = spawnWrapper(wrapperPath, ["--mirror", mirrorPath], dir, {
      encoding: "utf8",
      input: claudeCodeHookJson("git push --force-with-lease"), // deliberately NOT the denied pattern
      env: { ...process.env, MONET_STORAGE_DIR: dir },
    });
    expect(result.stdout).toBe(""); // unchanged: nothing is delivered

    const lines = readFileSync(join(dir, "gate-journal.jsonl"), "utf8")
      .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
    const hookDisposition = lines.filter((l) => l.mouth === "host-hook")[1];
    const gateDisposition = lines.filter((l) => l.mouth === "gate-cli")[1];
    expect(hookDisposition.disposition).toBe("silent");
    expect(gateDisposition.disposition).toBe("silent");
    expect(gateDisposition.ruleIds).toEqual([]);
  });
});

describe("install-cli: runInstall (real fs, isolated tmp dirs — never the real ~/.claude or ~/.monet)", () => {
  const dirs: string[] = [];
  const mkTmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "monet-install-cli-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("--dry-run writes nothing at all", () => {
    const home = mkTmp();
    const project = mkTmp();
    const settingsPath = join(project, ".claude", "settings.local.json");
    const wrapperPath = join(home, ".monet", "gate-hook.mjs");
    const setExitCode = () => {};
    runInstall(
      { dryRun: true },
      fakeDeps({ homeDir: () => home, projectDir: () => project, deriveCircle: () => "acme-widgets", setExitCode }),
    );
    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(wrapperPath)).toBe(false);
  });

  it("P2-C (Codex round 4 on PR #42): --project targeting a nonexistent path exits 1 before any side effect — nothing created, ensureMonetDir/deriveCircle never reached", () => {
    const home = mkTmp();
    const cwdProject = mkTmp();
    const parentDir = mkTmp();
    const bogusProject = join(parentDir, "typo-does-not-exist");
    let exitCode: number | undefined;
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => { errors.push(msg); };
    try {
      runInstall(
        { project: bogusProject },
        fakeDeps({
          homeDir: () => home,
          projectDir: () => cwdProject,
          // Neither should be reached at all — the refusal happens BEFORE the circle-pin section
          // these back. A throw makes "reached anyway" fail loudly rather than silently passing
          // for the wrong reason (stronger evidence than a call counter would give).
          ensureMonetDir: () => { throw new Error("must not be called — refused before any side effect"); },
          deriveCircle: () => { throw new Error("must not be called — refused before any side effect"); },
          setExitCode: (code: number) => { exitCode = code; },
        }),
      );
    } finally {
      console.error = originalError;
    }
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain(bogusProject); // "exit 1 naming the path"
    expect(existsSync(bogusProject)).toBe(false); // the typo'd path itself was never created
    expect(existsSync(join(home, ".monet"))).toBe(false); // wrapper never written
    expect(existsSync(join(cwdProject, ".claude"))).toBe(false); // no accidental fallback-project write
  });

  it("P2-C: the DEFAULT target (no --project: cwd/env-resolved) needs no existence check and installs normally", () => {
    const home = mkTmp();
    const project = mkTmp(); // mkTmp() itself creates the dir, so this always exists — the point
    runInstall({}, fakeDeps({ homeDir: () => home, projectDir: () => project, deriveCircle: () => "acme-widgets" }));
    expect(existsSync(join(project, ".claude", "settings.local.json"))).toBe(true);
  });

  it("a real (non-dry-run) install writes the wrapper (0755) and the project settings.local.json by default", () => {
    const home = mkTmp();
    const project = mkTmp();
    runInstall({}, fakeDeps({ homeDir: () => home, projectDir: () => project, deriveCircle: () => "acme-widgets" }));

    const wrapperPath = join(home, ".monet", "gate-hook.mjs");
    expect(existsSync(wrapperPath)).toBe(true);
    expect(statSync(wrapperPath).mode & 0o777).toBe(0o755);

    const settingsPath = join(project, ".claude", "settings.local.json");
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsFile;
    const handler = settings.hooks?.PreToolUse?.[0]?.hooks[0];
    // NIT (round-5 coordinator review, hooks.md:364/371-377): exec form now — command is just the
    // interpreter, args carries the wrapper path and the pinned --circle as SEPARATE elements,
    // never a shell-quoted string.
    expect(handler?.command).toBe("/usr/bin/node"); // fakeDeps' own monetInvocation() execPath
    expect(handler?.args?.[0]).toBe(wrapperPath);
    expect(handler?.args).toEqual([wrapperPath, "--circle", "acme-widgets"]);
  });

  it("--user targets ~/.claude/settings.json and does NOT pin a --circle", () => {
    const home = mkTmp();
    const project = mkTmp();
    const deriveCircle = () => { throw new Error("must not be called for a --user install"); };
    runInstall({ user: true }, fakeDeps({ homeDir: () => home, projectDir: () => project, deriveCircle }));

    const settingsPath = join(home, ".claude", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsFile;
    const handler = settings.hooks?.PreToolUse?.[0]?.hooks[0];
    expect(handler?.args).not.toContain("--circle");
  });

  it("idempotent re-run updates the entry in place — never duplicates, never touches an unrelated hook", () => {
    const home = mkTmp();
    const project = mkTmp();
    mkdirSync(join(project, ".claude"), { recursive: true });
    const settingsPath = join(project, ".claude", "settings.local.json");
    writeFileSync(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "./format.sh" }] }] },
    }));

    runInstall({}, fakeDeps({ homeDir: () => home, projectDir: () => project, deriveCircle: () => "circle-one" }));
    runInstall({}, fakeDeps({ homeDir: () => home, projectDir: () => project, deriveCircle: () => "circle-two" }));

    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsFile;
    const groups = settings.hooks?.PreToolUse ?? [];
    const bashGroup = groups.find((g) => g.matcher === BASH_MATCHER)!;
    expect(bashGroup.hooks).toHaveLength(1); // updated, not duplicated
    expect(bashGroup.hooks[0].args).toContain("circle-two"); // the SECOND run's value won
    expect(bashGroup.hooks[0].args).not.toContain("circle-one");
    const writeGroup = groups.find((g) => g.matcher === "Write")!;
    expect(writeGroup.hooks).toEqual([{ type: "command", command: "./format.sh" }]); // untouched
  });

  it("SHOULD-FIX 1: a foreign hook whose command merely references a DIFFERENT file named gate-hook.mjs survives install untouched", () => {
    const home = mkTmp();
    const project = mkTmp();
    mkdirSync(join(project, ".claude"), { recursive: true });
    const settingsPath = join(project, ".claude", "settings.local.json");
    // A user's OWN hook, nothing to do with Monet, that happens to reference a file with the
    // SAME NAME in a totally different directory — a reviewer probe proved the OLD bare-filename
    // substring match deleted exactly this.
    const foreignHandler = { type: "command", command: "/home/someone/my-own-scripts/gate-hook.mjs --verbose" };
    writeFileSync(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: BASH_MATCHER, hooks: [foreignHandler] }] },
    }));

    runInstall({}, fakeDeps({ homeDir: () => home, projectDir: () => project, deriveCircle: () => "acme-widgets" }));

    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsFile;
    const bashGroup = settings.hooks?.PreToolUse?.find((g) => g.matcher === BASH_MATCHER);
    expect(bashGroup?.hooks).toContainEqual(foreignHandler); // untouched, still present
    expect(bashGroup?.hooks).toHaveLength(2); // the foreign one PLUS the newly-installed one
  });

  it("refuses (never clobbers) an unparseable existing settings file", () => {
    const home = mkTmp();
    const project = mkTmp();
    mkdirSync(join(project, ".claude"), { recursive: true });
    const settingsPath = join(project, ".claude", "settings.local.json");
    writeFileSync(settingsPath, "{ this is not valid json");
    let exitCode: number | undefined;
    runInstall(
      {},
      fakeDeps({
        homeDir: () => home, projectDir: () => project, deriveCircle: () => "acme-widgets",
        setExitCode: (code) => { exitCode = code; },
      }),
    );
    expect(exitCode).toBe(1);
    expect(readFileSync(settingsPath, "utf8")).toBe("{ this is not valid json"); // byte-for-byte untouched
    expect(existsSync(join(home, ".monet", "gate-hook.mjs"))).toBe(false); // nothing else written either
  });

  describe("SHOULD-FIX 2: refuses valid-JSON-but-wrong-shape settings the same clean way as unparseable JSON", () => {
    function expectCleanRefusal(content: unknown): void {
      const home = mkTmp();
      const project = mkTmp();
      mkdirSync(join(project, ".claude"), { recursive: true });
      const settingsPath = join(project, ".claude", "settings.local.json");
      const original = JSON.stringify(content);
      writeFileSync(settingsPath, original);
      let exitCode: number | undefined;
      runInstall(
        {},
        fakeDeps({
          homeDir: () => home, projectDir: () => project, deriveCircle: () => "acme-widgets",
          setExitCode: (code) => { exitCode = code; },
        }),
      );
      expect(exitCode).toBe(1);
      expect(readFileSync(settingsPath, "utf8")).toBe(original); // byte-for-byte untouched
      expect(existsSync(join(home, ".monet", "gate-hook.mjs"))).toBe(false);
    }

    it("`hooks` present but a string, not an object", () => {
      expectCleanRefusal({ hooks: "not an object" });
    });

    it("`hooks.PreToolUse` present but a number, not an array", () => {
      expectCleanRefusal({ hooks: { PreToolUse: 42 } });
    });

    it("a matcher group's own `hooks` present but a string, not an array", () => {
      expectCleanRefusal({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: "not an array" }] } });
    });
  });

  describe("FIX 3 (Codex round 2 on PR #42): refuses to pin a wildcard or blank circle, before writing anything", () => {
    // MONET_CIRCLE='*' flows straight through deriveCircle's own env-override rung — the FIRST,
    // highest-priority check, ahead of every store/remote lookup — so a resolved '*' here is
    // EXACTLY what a stray MONET_CIRCLE='*' in the installing shell's environment would produce.
    // Without this fix it gets PERMANENTLY baked into the hook command: every later `monet gate`
    // call under that pin exits 1 (gate-cli's own QUERY_WILDCARD_CIRCLE usage-error refusal —
    // nothing evaluated), which the round-1 RECHECK fix now correctly surfaces as a LOUD
    // systemMessage on every single command, forever, even long after the env var is gone.
    it("deriveCircle resolving '*' refuses the install — exit 1, nothing written", () => {
      const home = mkTmp();
      const project = mkTmp();
      let exitCode: number | undefined;
      runInstall(
        {},
        fakeDeps({
          homeDir: () => home, projectDir: () => project, deriveCircle: () => "*",
          setExitCode: (code) => { exitCode = code; },
        }),
      );
      expect(exitCode).toBe(1);
      expect(existsSync(join(project, ".claude", "settings.local.json"))).toBe(false);
      expect(existsSync(join(home, ".monet", "gate-hook.mjs"))).toBe(false);
    });

    it("deriveCircle resolving '*' with surrounding whitespace ALSO refuses — trimmed before comparison", () => {
      const home = mkTmp();
      const project = mkTmp();
      let exitCode: number | undefined;
      runInstall(
        {},
        fakeDeps({
          homeDir: () => home, projectDir: () => project, deriveCircle: () => "  *  ",
          setExitCode: (code) => { exitCode = code; },
        }),
      );
      expect(exitCode).toBe(1);
      expect(existsSync(join(project, ".claude", "settings.local.json"))).toBe(false);
    });

    it("deriveCircle resolving an empty/whitespace-only string ALSO refuses (defensive — not currently reachable through normal resolution, matching gate-cli.ts's own backstop posture for the identical constant)", () => {
      const home = mkTmp();
      const project = mkTmp();
      let exitCode: number | undefined;
      runInstall(
        {},
        fakeDeps({
          homeDir: () => home, projectDir: () => project, deriveCircle: () => "   ",
          setExitCode: (code) => { exitCode = code; },
        }),
      );
      expect(exitCode).toBe(1);
      expect(existsSync(join(project, ".claude", "settings.local.json"))).toBe(false);
    });

    it("the refusal message names MONET_CIRCLE as the likely source", () => {
      const home = mkTmp();
      const project = mkTmp();
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (msg: string) => { errors.push(msg); };
      try {
        runInstall({}, fakeDeps({ homeDir: () => home, projectDir: () => project, deriveCircle: () => "*" }));
      } finally {
        console.error = originalError;
      }
      expect(errors.join("\n")).toContain("MONET_CIRCLE");
    });

    it("--user scope never even calls deriveCircle, so this refusal cannot fire there (no pin is attempted at all)", () => {
      const home = mkTmp();
      const project = mkTmp();
      const deriveCircle = () => "*"; // would refuse if ever called
      let exitCode: number | undefined;
      runInstall(
        { user: true },
        fakeDeps({ homeDir: () => home, projectDir: () => project, deriveCircle, setExitCode: (code) => { exitCode = code; } }),
      );
      expect(exitCode).toBeUndefined(); // never set — the install proceeds normally
      expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true);
    });
  });

  it("prints the coverage report either way (dry-run or real)", () => {
    const home = mkTmp();
    const project = mkTmp();
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => { logs.push(msg); };
    try {
      runInstall(
        { dryRun: true },
        fakeDeps({ homeDir: () => home, projectDir: () => project, deriveCircle: () => "acme-widgets" }),
      );
    } finally {
      console.log = originalLog;
    }
    expect(logs.join("\n")).toContain("Coverage report");
    expect(logs.join("\n")).toContain("git push origin main --force");
  });
});

describe("install-cli: P1-B (Codex round 1 on PR #42) — the circle pin resolves against the TARGET's own store, not the caller's", () => {
  // Uses the REAL circle.ts deriveCircle (not a fake) — that is exactly what this fix touches;
  // faking it would test nothing about the bug. Real git repos + real sqlite stores in tmp dirs.
  const dirs: string[] = [];
  const mkTmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "monet-p1b-"));
    dirs.push(dir);
    return dir;
  };
  let savedStorageDir: string | undefined;
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    // getMonetDir() checks MONET_STORAGE_DIR FIRST, before the baseDir argument this fix threads
    // through — leaving it set would override BOTH the caller's and target's own project-local
    // store and mask the exact rung this fix touches. Every test in this block deletes it; restore
    // whatever the surrounding suite had afterward.
    if (savedStorageDir !== undefined) process.env.MONET_STORAGE_DIR = savedStorageDir;
    else delete process.env.MONET_STORAGE_DIR;
  });

  /** A throwaway git repo at `dir` with the given origin remote. */
  function makeRepoWithRemote(dir: string, url: string): void {
    const g = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    g(["init", "--quiet"]);
    g(["config", "user.email", "test@example.com"]);
    g(["config", "user.name", "Test"]);
    writeFileSync(join(dir, "README.md"), "# fixture\n");
    g(["add", "."]);
    g(["commit", "--quiet", "-m", "init"]);
    g(["remote", "add", "origin", url]);
  }

  /** Pre-seeds `<dir>/.monet/monet.db` with a `remote_circle_map` row for `url` → `circle`, the
   *  same shape circle.ts's own `openMapStore`/`writeMap` produce. */
  function seedProjectStore(dir: string, url: string, circle: string): void {
    const storeDir = join(dir, ".monet");
    mkdirSync(storeDir, { recursive: true });
    const db = new Database(join(storeDir, "monet.db"));
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS remote_circle_map (
        remote_url TEXT PRIMARY KEY,
        circle     TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
    `);
    db.prepare(`INSERT INTO remote_circle_map (remote_url, circle) VALUES (?, ?)`).run(canonicalRemoteKey(url), circle);
    db.close();
  }

  it("install --project <targetDir>: the pin reflects the TARGET's own store, not whatever store the caller's cwd would have resolved", () => {
    const REMOTE_URL = "git@github.com:acme/p1b-fixture.git";
    const callerDir = mkTmp();
    const targetDir = mkTmp();
    makeRepoWithRemote(callerDir, REMOTE_URL);
    makeRepoWithRemote(targetDir, REMOTE_URL);
    seedProjectStore(callerDir, REMOTE_URL, "caller-store-circle");
    seedProjectStore(targetDir, REMOTE_URL, "target-store-circle");
    savedStorageDir = process.env.MONET_STORAGE_DIR;
    delete process.env.MONET_STORAGE_DIR;
    const fakeHome = mkTmp();

    runInstall(
      { project: targetDir }, // simulates: sitting in your OWN repo (caller), installing FOR another
      {
        homeDir: () => fakeHome,
        projectDir: () => callerDir, // what cwd resolves to when the invoker never overrides it
        deriveCircle, // the REAL circle.ts function — this is exactly what P1-B fixes
        monetInvocation: () => ({ execPath: "/usr/bin/node", scriptPath: "/opt/monet/dist/cli.js" }),
        ensureMonetDir: () => { const d = join(fakeHome, ".monet"); mkdirSync(d, { recursive: true }); return d; },
        setExitCode: () => {},
      },
    );

    const settingsPath = join(targetDir, ".claude", "settings.local.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsFile;
    const handler = settings.hooks?.PreToolUse?.[0]?.hooks[0];
    expect(handler?.args).toContain("target-store-circle");
    expect(handler?.args).not.toContain("caller-store-circle");
  });

  // NOTE ON WHAT "INVERSE GUARD" ACTUALLY PROVES (stated precisely after running this test against
  // the pre-fix source for red-green evidence): this is NOT "old and new code behave identically
  // here". The pre-fix code failed this test TOO — openMapStore() ignored its caller's projectDir
  // entirely and always resolved via getMonetDir(process.cwd()), so it never even reliably served
  // the ordinary, no-`--project` case whenever the RESOLVED project dir (deps.projectDir(), the
  // real CLI's resolveProjectDir() — MONET_PROJECT_DIR/CLAUDE_PROJECT_DIR, else cwd) diverges from
  // the raw OS cwd, which is exactly the shape resolveProjectDir() exists to handle (a host
  // spawning `monet` from elsewhere). What this test actually proves is narrower and simpler: the
  // FIXED code correctly serves the no-`--project` case (reads the resolved project's own store),
  // without a regression for that path. See the P1-B fix's own comment in circle.ts for the
  // audited case where a caller's "projectDir" IS the raw cwd in ordinary usage (the common case,
  // unaffected either way) vs. this test's deliberately-diverging harness (the override case).
  it("without --project, the pin reflects the resolved project's OWN store — no regression on the ordinary path", () => {
    const REMOTE_URL = "git@github.com:acme/p1b-inverse-fixture.git";
    const callerDir = mkTmp();
    makeRepoWithRemote(callerDir, REMOTE_URL);
    seedProjectStore(callerDir, REMOTE_URL, "caller-store-circle");
    savedStorageDir = process.env.MONET_STORAGE_DIR;
    delete process.env.MONET_STORAGE_DIR;
    const fakeHome = mkTmp();

    runInstall(
      {}, // no --project: target.projectDir falls back to deps.projectDir()
      {
        homeDir: () => fakeHome,
        projectDir: () => callerDir,
        deriveCircle,
        monetInvocation: () => ({ execPath: "/usr/bin/node", scriptPath: "/opt/monet/dist/cli.js" }),
        ensureMonetDir: () => { const d = join(fakeHome, ".monet"); mkdirSync(d, { recursive: true }); return d; },
        setExitCode: () => {},
      },
    );

    const settingsPath = join(callerDir, ".claude", "settings.local.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsFile;
    const handler = settings.hooks?.PreToolUse?.[0]?.hooks[0];
    expect(handler?.args).toContain("caller-store-circle");
  });
});

describe("install-cli: FIX 4 (Codex round 2 on PR #42) — --dry-run never touches real storage", () => {
  const dirs: string[] = [];
  const mkTmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "monet-fix4-"));
    dirs.push(dir);
    return dir;
  };
  let savedStorageDir: string | undefined;
  let savedHome: string | undefined;
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (savedStorageDir !== undefined) process.env.MONET_STORAGE_DIR = savedStorageDir;
    else delete process.env.MONET_STORAGE_DIR;
    if (savedHome !== undefined) process.env.HOME = savedHome;
  });

  it("against a target with no .monet at all: creates no directory, no db file — ensureMonetDir is never even called", () => {
    savedStorageDir = process.env.MONET_STORAGE_DIR;
    savedHome = process.env.HOME;
    delete process.env.MONET_STORAGE_DIR;
    const home = mkTmp();
    process.env.HOME = home; // getMonetDir's own fallback rung — isolates it from the real ~/.monet
    const project = mkTmp();

    runInstall(
      { dryRun: true },
      {
        homeDir: () => home, projectDir: () => project, deriveCircle,
        monetInvocation: () => ({ execPath: "/usr/bin/node", scriptPath: "/opt/monet/dist/cli.js" }),
        ensureMonetDir: () => { throw new Error("FIX 4: ensureMonetDir must not be called on --dry-run"); },
        setExitCode: () => {},
      },
    );

    expect(existsSync(join(project, ".monet"))).toBe(false);
    expect(existsSync(join(home, ".monet"))).toBe(false); // the fallback location — also untouched
    expect(existsSync(join(project, ".claude"))).toBe(false);
  });

  it("against a store WITH content: the dry-run pin matches a real install's pin, and the store file is BYTE-IDENTICAL before/after (hash check)", () => {
    savedStorageDir = process.env.MONET_STORAGE_DIR;
    delete process.env.MONET_STORAGE_DIR;
    const project = mkTmp();
    const remoteUrl = "git@github.com:acme/fix4-fixture.git";
    const g = (args: string[]): void => {
      execFileSync("git", args, { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
    };
    g(["init", "--quiet"]);
    g(["config", "user.email", "test@example.com"]);
    g(["config", "user.name", "Test"]);
    writeFileSync(join(project, "README.md"), "# fixture\n");
    g(["add", "."]);
    g(["commit", "--quiet", "-m", "init"]);
    g(["remote", "add", "origin", remoteUrl]);

    // A real, pre-seeded remote_circle_map row — matching the P1-B fixture pattern (round 1, same PR).
    const storeDir = join(project, ".monet");
    mkdirSync(storeDir, { recursive: true });
    const dbPath = join(storeDir, "monet.db");
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE remote_circle_map (
        remote_url TEXT PRIMARY KEY, circle TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
    `);
    db.prepare(`INSERT INTO remote_circle_map (remote_url, circle) VALUES (?, ?)`)
      .run(canonicalRemoteKey(remoteUrl), "fix4-mapped-circle");
    db.close();

    const beforeHash = createHash("sha256").update(readFileSync(dbPath)).digest("hex");

    const logs: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (msg: string) => { logs.push(msg); };
    console.error = () => {};
    try {
      runInstall(
        { dryRun: true, project },
        {
          homeDir: () => mkTmp(), projectDir: () => project, deriveCircle,
          monetInvocation: () => ({ execPath: "/usr/bin/node", scriptPath: "/opt/monet/dist/cli.js" }),
          ensureMonetDir: () => { throw new Error("FIX 4: ensureMonetDir must not be called on --dry-run"); },
          setExitCode: () => {},
        },
      );
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    // BYTE-IDENTICAL: the dry-run preview must not have mutated the store file at all.
    const afterHash = createHash("sha256").update(readFileSync(dbPath)).digest("hex");
    expect(afterHash).toBe(beforeHash);

    // Pull the pin out of the dry-run's own structured JSON preview (not by parsing prose).
    const jsonLine = logs.find((l) => l.trim().startsWith("{"));
    expect(jsonLine).toBeDefined();
    const preview = JSON.parse(jsonLine!) as SettingsFile;
    const dryRunArgs = preview.hooks?.PreToolUse?.[0]?.hooks[0]?.args;
    expect(dryRunArgs).toContain("fix4-mapped-circle");

    // Not vacuous: a REAL (non-dry-run) install against the SAME store resolves to the SAME pin.
    const realHome = mkTmp();
    runInstall(
      { project },
      {
        homeDir: () => realHome, projectDir: () => project, deriveCircle,
        monetInvocation: () => ({ execPath: "/usr/bin/node", scriptPath: "/opt/monet/dist/cli.js" }),
        ensureMonetDir: () => { mkdirSync(join(realHome, ".monet"), { recursive: true }); return join(realHome, ".monet"); },
        setExitCode: () => {},
      },
    );
    const realSettings = JSON.parse(readFileSync(join(project, ".claude", "settings.local.json"), "utf8")) as SettingsFile;
    const realArgs = realSettings.hooks?.PreToolUse?.[0]?.hooks[0]?.args;
    expect(realArgs).toContain("fix4-mapped-circle");
  });
});

describe("install-cli: FIX 5 (Codex round 2 on PR #42) — atomic write-then-rename, never truncate-in-place", () => {
  const dirs: string[] = [];
  const mkTmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "monet-fix5-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("a successful write leaves NO .tmp sibling behind, and the target has exactly the new content", () => {
    const dir = mkTmp();
    const targetPath = join(dir, "settings.local.json");
    writeFileSync(targetPath, "ORIGINAL CONTENT");

    atomicWriteFile(targetPath, "NEW CONTENT", 0o644);

    expect(readFileSync(targetPath, "utf8")).toBe("NEW CONTENT");
    const entries = readdirSync(dir);
    expect(entries).toEqual(["settings.local.json"]); // no stray .tmp sibling
    expect(statSync(targetPath).mode & 0o777).toBe(0o644);
  });

  it("a FAILED write (target directory not writable — the tmp file can never be created) leaves the ORIGINAL file's content completely untouched, never truncated", () => {
    const dir = mkTmp();
    const targetPath = join(dir, "settings.local.json");
    writeFileSync(targetPath, "ORIGINAL CONTENT — MUST SURVIVE");
    // Directory write bit removed: creating a NEW entry (the tmp file) in it now fails, while the
    // EXISTING target file's own content is untouched by this chmod alone.
    chmodSync(dir, 0o555);
    try {
      expect(() => atomicWriteFile(targetPath, "NEW CONTENT THAT MUST NEVER LAND")).toThrow();
    } finally {
      chmodSync(dir, 0o755); // restore so afterEach's rmSync can clean up
    }
    // THE ATOMICITY PROOF: a write that never completed the tmp-then-rename sequence must never
    // have touched the original — a truncate-in-place write, by contrast, would have destroyed
    // "ORIGINAL CONTENT" the moment it opened the file for writing, before the failure even
    // registered.
    expect(readFileSync(targetPath, "utf8")).toBe("ORIGINAL CONTENT — MUST SURVIVE");
  });

  it("structural: a real (non-dry-run) runInstall write leaves no .tmp sibling in either target directory", () => {
    const home = mkTmp();
    const project = mkTmp();
    runInstall({}, {
      homeDir: () => home, projectDir: () => project, deriveCircle: () => "acme-widgets",
      monetInvocation: () => ({ execPath: "/usr/bin/node", scriptPath: "/opt/monet/dist/cli.js" }),
      ensureMonetDir: () => { const d = join(home, ".monet"); mkdirSync(d, { recursive: true }); return d; },
      setExitCode: () => {},
    });
    const settingsEntries = readdirSync(join(project, ".claude"));
    const monetEntries = readdirSync(join(home, ".monet"));
    expect(settingsEntries.some((n) => n.endsWith(".tmp"))).toBe(false);
    expect(monetEntries.some((n) => n.endsWith(".tmp"))).toBe(false);
    expect(settingsEntries).toContain("settings.local.json");
    expect(monetEntries).toContain("gate-hook.mjs");
  });

  it("P2-4 (Codex round 3 on PR #42): a pre-existing settings file's own mode (0600) survives an install re-run — never widened to the process umask's default", () => {
    const home = mkTmp();
    const project = mkTmp();
    mkdirSync(join(project, ".claude"), { recursive: true });
    const settingsPath = join(project, ".claude", "settings.local.json");
    writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [] } }), { mode: 0o600 });
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);

    runInstall({}, {
      homeDir: () => home, projectDir: () => project, deriveCircle: () => "acme-widgets",
      monetInvocation: () => ({ execPath: "/usr/bin/node", scriptPath: "/opt/monet/dist/cli.js" }),
      ensureMonetDir: () => { const d = join(home, ".monet"); mkdirSync(d, { recursive: true }); return d; },
      setExitCode: () => {},
    });

    expect(statSync(settingsPath).mode & 0o777).toBe(0o600); // preserved, not widened
    // Content genuinely updated too — this isn't "the write silently no-op'd".
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsFile;
    expect(settings.hooks?.PreToolUse?.some((g) => g.matcher === BASH_MATCHER)).toBe(true);
  });

  it("P2-4: the WRAPPER's own mode (0755) is unaffected by mode preservation — it is FORCED, never preserved, since a caller passes an explicit mode", () => {
    const home = mkTmp();
    const project = mkTmp();
    const wrapperPath = join(home, ".monet", "gate-hook.mjs");
    mkdirSync(join(home, ".monet"), { recursive: true });
    // Pre-exists at a WRONG, non-executable mode — a real scenario (a user's own umask, or a
    // stray hand-edit) the wrapper must self-heal from on every install, never preserve.
    writeFileSync(wrapperPath, "old stale content", { mode: 0o644 });

    runInstall({}, {
      homeDir: () => home, projectDir: () => project, deriveCircle: () => "acme-widgets",
      monetInvocation: () => ({ execPath: "/usr/bin/node", scriptPath: "/opt/monet/dist/cli.js" }),
      ensureMonetDir: () => { const d = join(home, ".monet"); mkdirSync(d, { recursive: true }); return d; },
      setExitCode: () => {},
    });

    expect(statSync(wrapperPath).mode & 0o777).toBe(0o755); // forced back to executable
  });

  it("P2-5 (Codex round 3 on PR #42): a SYMLINKED settings file — the symlink survives untouched, and the REAL file it points at (possibly in a different directory, e.g. a dotfiles repo) carries the new content", () => {
    const home = mkTmp();
    const project = mkTmp();
    const dotfilesDir = mkTmp(); // simulates a separate dotfiles repo elsewhere on disk
    mkdirSync(join(project, ".claude"), { recursive: true });
    const realSettingsPath = join(dotfilesDir, "settings.local.json");
    writeFileSync(realSettingsPath, JSON.stringify({ hooks: { PreToolUse: [] } }));
    const settingsPath = join(project, ".claude", "settings.local.json");
    symlinkSync(realSettingsPath, settingsPath);

    runInstall({}, {
      homeDir: () => home, projectDir: () => project, deriveCircle: () => "acme-widgets",
      monetInvocation: () => ({ execPath: "/usr/bin/node", scriptPath: "/opt/monet/dist/cli.js" }),
      ensureMonetDir: () => { const d = join(home, ".monet"); mkdirSync(d, { recursive: true }); return d; },
      setExitCode: () => {},
    });

    // The symlink ITSELF survives — still a symlink, still pointing at the real file. Refusing
    // (or silently replacing it with a plain file) would be hostile to a deliberate dotfiles
    // setup; writing through instead leaves the user's own symlink completely untouched.
    expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
    expect(realpathSync(settingsPath)).toBe(realpathSync(realSettingsPath));
    // The REAL file carries the new content (not a new plain file replacing the symlink).
    const settings = JSON.parse(readFileSync(realSettingsPath, "utf8")) as SettingsFile;
    expect(settings.hooks?.PreToolUse?.some((g) => g.matcher === BASH_MATCHER)).toBe(true);
    // The tmp file lived in the REAL file's own directory (dotfilesDir), never project/.claude —
    // no stray .tmp residue in either.
    expect(readdirSync(dotfilesDir).some((n) => n.endsWith(".tmp"))).toBe(false);
    expect(readdirSync(join(project, ".claude")).some((n) => n.endsWith(".tmp"))).toBe(false);
  });
});

describe("install-cli: P2-6 (Codex round 3 on PR #42) — isMonetGateHandler boundary-matches the wrapper path, never a bare substring", () => {
  const dirs: string[] = [];
  const mkTmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "monet-p2-6-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("unit: a wrapper path that is a PREFIX of a longer, different filename (<wrapperPath>.backup) does not match, quoted or bare; the real path still matches at every legitimate boundary", () => {
    const wrapperPath = "/home/x/.monet/gate-hook.mjs";
    // THE BUG: .includes() matched a wrapper path that is merely a substring of a longer name.
    expect(isMonetGateHandler({ type: "command", command: `node '${wrapperPath}.backup'` }, wrapperPath)).toBe(false);
    expect(isMonetGateHandler({ type: "command", command: `node ${wrapperPath}.backup` }, wrapperPath)).toBe(false);
    expect(isMonetGateHandler({ type: "command", command: `node "${wrapperPath}.backup"` }, wrapperPath)).toBe(false);
    // THE FIX must still recognize the real thing at every legitimate shell-argument boundary.
    expect(isMonetGateHandler({ type: "command", command: `node ${wrapperPath}` }, wrapperPath)).toBe(true); // end-of-string
    expect(isMonetGateHandler({ type: "command", command: `node '${wrapperPath}'` }, wrapperPath)).toBe(true); // single-quoted
    expect(isMonetGateHandler({ type: "command", command: `node "${wrapperPath}"` }, wrapperPath)).toBe(true); // double-quoted
    expect(isMonetGateHandler({ type: "command", command: `node ${wrapperPath} --circle acme` }, wrapperPath)).toBe(true); // followed by whitespace
  });

  it("a foreign handler referencing <wrapperPath>.backup (a real, hand-made backup file) SURVIVES an install untouched", () => {
    const home = mkTmp();
    const project = mkTmp();
    mkdirSync(join(project, ".claude"), { recursive: true });
    const settingsPath = join(project, ".claude", "settings.local.json");
    const wrapperPath = join(home, ".monet", "gate-hook.mjs");
    const foreignHandler = { type: "command", command: `/usr/bin/node '${wrapperPath}.backup'` };
    writeFileSync(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: BASH_MATCHER, hooks: [foreignHandler] }] },
    }));

    runInstall({}, {
      homeDir: () => home, projectDir: () => project, deriveCircle: () => "acme-widgets",
      monetInvocation: () => ({ execPath: "/usr/bin/node", scriptPath: "/opt/monet/dist/cli.js" }),
      ensureMonetDir: () => { const d = join(home, ".monet"); mkdirSync(d, { recursive: true }); return d; },
      setExitCode: () => {},
    });

    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsFile;
    const bashGroup = settings.hooks?.PreToolUse?.find((g) => g.matcher === BASH_MATCHER);
    expect(bashGroup?.hooks).toContainEqual(foreignHandler); // untouched, still present
    expect(bashGroup?.hooks).toHaveLength(2); // the foreign one PLUS the newly-installed one
  });
});

describe("install-cli: registered command (real CLI process)", () => {
  it("--help documents the command and its flags", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", TSX_LOADER, "src/cli.ts", "install", "--help"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: monet install");
    expect(result.stdout).toContain("--project");
    expect(result.stdout).toContain("--user");
    expect(result.stdout).toContain("--dry-run");
  });
});
