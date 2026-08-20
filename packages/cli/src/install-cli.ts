import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path, { basename, dirname, join } from "node:path";
import { Command } from "commander";
import { deriveCircle } from "./circle.js";
import { ensureMonetDir } from "./db/index.js";
import { GATE_FAIL_OPEN_MARKER, QUERY_WILDCARD_CIRCLE } from "./gate-cli.js";
import { resolveProjectDir } from "./project-dir.js";

/**
 * `monet install` — wires a Claude Code PreToolUse hook that calls `monet gate` (4b-D, component
 * C). This is the command the tool-surface doc's `monet install` row names ("Wires the static
 * hooks per host surface; emits the coverage report naming wired and unwired surfaces") and the
 * boundary statement's own binding-consequences items 2/3/4/6 govern (failure policy, advisory-
 * to-the-host mapping, user-channel visibility, and the hook write posture respectively).
 *
 * PROTOCOL SOURCE OF TRUTH: every claim about Claude Code's own hook protocol below is cited
 * against https://code.claude.com/docs/en/hooks, section names quoted where they matter. As of
 * the round-5 coordinator review, every LINE citation (`hooks.md:NNNN`) in this file is checked
 * against a reviewer-saved verbatim copy of that page (not re-fetched, not recalled from memory)
 * so every claim below is independently verifiable against a fixed text, not a moving live page:
 *   - "PreToolUse": stdin JSON shape (`tool_name`, `tool_input.command`, ...).
 *   - "JSON output": universal fields available on any hook's output (`systemMessage`, hooks.md:771).
 *   - "PreToolUse decision control" (hooks.md:1533-1572): `hookSpecificOutput.permissionDecision`
 *     takes exactly `"allow" | "deny" | "ask" | "defer"` (hooks.md:1539) — that enum listing was
 *     always correct; what this file got WRONG until this review was what `"defer"` actually DOES
 *     (see the correction below, and buildWrapperScript's own top comment for the full trail).
 *   - "Configuration": settings.json shape — `hooks.<Event>` is an array of matcher groups, each
 *     `{ matcher, hooks: [...] }`, each handler `{ type: "command", command, ... }`.
 *   - "Hook locations": `~/.claude/settings.json` (user) vs `.claude/settings.json` (project,
 *     shareable) vs `.claude/settings.local.json` (project, gitignored) — see
 *     resolveInstallTarget's own comment for why this command's project default is the THIRD one,
 *     not the second.
 *   - "Exec form and shell form" (hooks.md:369-410): a command hook runs as exec form — spawned
 *     directly, "no shell tokenization happens on any platform" (hooks.md:375) — when `args` is
 *     set, and shell form (needing quoting) when it is omitted. runInstall now writes exec-form
 *     handlers (`command: execPath, args: [wrapperPath, ...]`) — see runInstall's own comment for
 *     why this replaced the old shellQuote-based shell-form string.
 *
 * CORRECTED, ROUND-5: `permissionDecision: "defer"` is NOT a generic "no opinion, hand back to
 * the host's own normal flow" value — that was this file's own reading through slice 4b-D, and it
 * was wrong. `"defer"` exists for an entirely different purpose (an out-of-band `claude -p
 * --resume` integration pausing a single tool call, hooks.md:1574-1610) and is silently IGNORED
 * in interactive sessions (hooks.md:1576-1577) while, in non-interactive (`-p`) sessions, it EXITS
 * THE WHOLE PROCESS with `stop_reason: "tool_deferred"` (hooks.md:1581) expecting a resume this
 * hook never triggers. Built the way slice 4b-D built it, EVERY ungoverned Bash command — the
 * overwhelming majority of them — would have failed to execute under `claude -p`, exactly
 * inverting this project's whole fail-open failure policy for the single most common host runtime
 * a hook actually runs under. The corrected, doc-supported idiom is exit 0 with NOTHING written
 * to stdout (hooks.md:148: "Exit code 0 with no output means the hook has no decision to report,
 * so the tool call continues through the normal permission flow. The hook can deny the call, but
 * staying silent doesn't approve it.") — see buildWrapperScript's own top comment for the full
 * citation trail and exactly which outcomes this applies to.
 *
 * ARCHITECTURE: `monet gate` itself stays host-agnostic (it already speaks a plain, documented
 * exit-code/stdout contract — see gate-cli.ts — that says nothing about Claude Code specifically).
 * The Claude-Code-specific adapter is a SEPARATE generated wrapper script (buildWrapperScript,
 * below), written to `~/.monet/gate-hook.mjs` and invoked by the settings.json hook entry this
 * command writes. This is deliberate separation, matching the design's own
 * "monet gate injection format per host hook contract... decided at slice 4 with the host wiring,
 * one adapter per surface" — this module IS that one adapter, for the one host this slice wires.
 */

// ── The generated wrapper script ─────────────────────────────────────────────────────────────

const WRAPPER_FILENAME = "gate-hook.mjs";
/**
 * The argv marker that tells the one wrapper script it was invoked for PostToolUse rather than
 * PreToolUse. Exported so `runInstall` writes exactly the string the generated script checks for —
 * a literal spelled twice is a literal that drifts, and a drifted one here would silently turn
 * every outcome record off while the install still looked correct.
 */
export const POST_TOOL_USE_FLAG = "--post-tool-use";
const DENY_LOG_FILENAME = "gate-denies.log";
/**
 * Generates the wrapper script's FULL source. Written fresh on every `monet install` run — safe
 * to overwrite unconditionally because the ONE thing baked in here (the resolved `monet`
 * invocation) does not vary by install scope (project vs user); the one thing that DOES vary (an
 * optional `--circle` pin) is forwarded from the settings.json command line as an argument to
 * THIS script, never hardcoded in it — see upsertMonetGateHook's own comment for why that
 * separation is what lets a project-scoped install and a user-global install coexist without
 * fighting over this one shared file.
 *
 * DENY LOG (boundary statement item 6): on a deny (exit 30) this script appends ONE line — ISO
 * timestamp, the circle it ran under if pinned, the first stdout line — to
 * `~/.monet/gate-denies.log`, created 0600 (mode supplied at the `openSync` call that creates it,
 * never chmod-after — the sidecar-materializer precedent) and append-only thereafter. It is a plain
 * text file a human can `tail`, and that is the whole of what it is for.
 *
 * IT IS NO LONGER THE ONLY RECORD OF A DENY, and this comment used to say that it was. A deny is
 * now also a governed moment carrying `disposition: "blocked"`, written by `monet gate` with the
 * stage and the rule ids that produced it — strictly more than this line holds, and queryable. The
 * sole-record claim was true when it was written and stopped being true when the governed-moment
 * record landed.
 *
 * WHETHER THIS FILE IS STILL WORTH KEEPING IS OPEN, deliberately left that way rather than settled
 * here. For: a tail-able text file needs no store, no fold and no query surface, and it survives a
 * store that will not open. Against: it is now a second, weaker copy of a fact the moment record
 * already holds, and two populations describing one event is the shape this subsystem's own rebuild
 * exists to remove. Not decided in this pass — the file is user-facing and somebody may be tailing
 * it, so removing it is a separate decision from the work that made the question live.
 */
export function buildWrapperScript(opts: { execPath: string; scriptPath: string }): string {
  return `#!/usr/bin/env node
// Generated by \`monet install\` — DO NOT EDIT BY HAND; re-run \`monet install\` to regenerate.
//
// Bridges Claude Code's PreToolUse hook protocol (https://code.claude.com/docs/en/hooks —
// "PreToolUse", "JSON output", "PreToolUse decision control") to the host-agnostic \`monet gate\`
// CLI. This file is safe to overwrite on every install: the monet invocation below is the only
// thing baked in, and it does not vary by install scope. An optional --circle pin (or any other
// forwarded flag) arrives via this script's OWN argv (this file's line in settings.json), never
// hardcoded here.
//
// CORRECTED PROTOCOL UNDERSTANDING (round-5 coordinator review — line numbers below are checked
// against a reviewer-saved verbatim copy of https://code.claude.com/docs/en/hooks, not re-fetched
// and not recalled from memory; see install-cli.ts's own module comment for the same trail):
// permissionDecision:"defer" is NOT a generic "hand back to normal flow" value. It exists for an
// out-of-band \`claude -p --resume\` integration to pause a single tool call (hooks.md:1574-1610),
// is silently IGNORED in interactive sessions (hooks.md:1576-1577: "Claude Code honors this value
// only in non-interactive mode with the -p flag. In interactive sessions it logs a warning and
// ignores the hook result"), and in non-interactive (\`-p\`) sessions EXITS THE WHOLE PROCESS with
// stop_reason:"tool_deferred" (hooks.md:1581) expecting a resume this hook never triggers. The
// actual pass-through idiom, correct in BOTH modes, is exit 0 with NOTHING on stdout — hooks.md:148:
// "Exit code 0 with no output means the hook has no decision to report, so the tool call continues
// through the normal permission flow. The hook can deny the call, but staying silent doesn't
// approve it." Every branch below that has nothing to report is now a bare \`return\` out of
// main() with no emit() call at all — see main()'s own comment.

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MONET_EXEC = ${JSON.stringify(opts.execPath)};
const MONET_SCRIPT = ${JSON.stringify(opts.scriptPath)};
// P1-A (Codex round 1 on PR #42): baked in at GENERATION time from gate-cli.ts's own EXPORTED
// GATE_FAIL_OPEN_MARKER — never re-typed here as a bare literal, so a wording change to the
// marker's own value on the gate-cli.ts side cannot silently desync from what this wrapper greps
// for. See main()'s own "default:" case for the detection, and gate-cli.ts's own comment on the
// constant for the full bug this closes.
const GATE_FAIL_OPEN_MARKER = ${JSON.stringify(GATE_FAIL_OPEN_MARKER)};
// The record's path resolves at RUN time: MONET_STORAGE_DIR first (the same override db/index.ts's own
// storage resolution honors — and what lets tests isolate this wrapper without touching the real
// ~/.monet), else ~/.monet. The cwd rung of that resolution is DELIBERATELY absent here: a hook's
// cwd is whatever directory the host happened to spawn from — the exact wrong-project hazard the
// gate CLI's own default-mirror-path fix closed (4b-C Blocker 1) — and a record that silently
// lands in a random project's .monet would be worse than one that always lands in the home store.
const MONET_STORAGE_DIR = process.env.MONET_STORAGE_DIR || join(homedir(), ".monet");
const DENY_LOG_PATH = join(MONET_STORAGE_DIR, ${JSON.stringify(DENY_LOG_FILENAME)});
const POST_TOOL_USE_FLAG = ${JSON.stringify(POST_TOOL_USE_FLAG)};
// SHOULD-FIX 4 (round-5 coordinator review): mirrors gate-cli.ts's own readStdinSync EXACTLY —
// see that function's comment (src/gate-cli.ts) for the full EAGAIN story: a plain
// \`readFileSync(0, "utf8")\` fails on a non-blocking piped stdin under load (reproduced reliably
// with a multi-MB payload), which is exactly the large-command case this wrapper forwards via
// --stdin to serve. Keep this loop textually in sync with readStdinSync; that function's own
// comment cross-references this one right back.
//
// P2-7 (Codex round 3 on PR #42): bounded retention, SAME MECHANISM as gate-cli.ts's own
// readStdinSync (retention stops, draining continues, once the cap is crossed — see that
// function's own comment for the full reasoning) but a DIFFERENT, LARGER cap, deliberately not
// identical — found by this fix's own test, not assumed: gate-cli.ts's readStdinSync retains RAW
// ACTION-CONTEXT TEXT, which tolerates truncation gracefully (evaluateGateFromMirror only checks
// \`text.length > threshold\`, so a truncated-but-still-huge string still correctly reports
// overflow). This function retains a JSON ENVELOPE (the whole hook payload, tool_input.command
// nested inside it) that MUST be complete and well-formed to parse AT ALL — truncating it at
// gate-cli's own 5 MiB would break JSON.parse for any legitimate command whose JSON-encoded size
// (the command itself, plus quoting/escaping overhead, plus the small fixed envelope fields)
// exceeds 5 MiB — which is EXACTLY the overflow-ask scenario (a command intentionally near or past
// the engine's 4 MiB threshold) this wrapper most needs to relay correctly. 16 MiB — reusing FIX
// 2's own MAX_BUFFER constant and its identical justification ("far past any legitimate gate
// output") — gives generous headroom for JSON-encoding overhead on any REALISTIC command (shell
// commands are overwhelmingly plain ASCII, needing little to no escaping) while remaining a hard,
// meaningful ceiling against a truly hostile, unbounded payload (bounding heap growth at ~16 MiB
// instead of the payload's own size, however large). A pathological command consisting almost
// entirely of characters requiring \\uXXXX escaping could still exceed even this generously-padded
// cap — accepted, not solved: the worst case then is BLOCKER 1's own existing silent pass-through
// (JSON.parse throws, caught, bare \`return\`, fail open) instead of the intended ask, which is
// still a safe failure mode for a vanishingly unlikely input shape, never a wrongly-enforced block
// or a crash.
const RETAINED_STDIN_CAP_BYTES = 16 * 1024 * 1024;

// P1-A (Codex round 4 on PR #42): returns { text, truncated } instead of a bare string —
// \`truncated\` reports whether retention ever crossed RETAINED_STDIN_CAP_BYTES (i.e. whether ANY
// bytes were drained-without-retaining below). main() uses this to tell "JSON.parse failed because
// THIS truncated the envelope mid-string" apart from "JSON.parse failed for some other reason on a
// well-under-cap payload" — see main()'s own comment for why that distinction is the fix itself.
function readAllStdin() {
  const chunks = [];
  let retainedBytes = 0;
  // BYTES ARRIVED, counted across everything read including what is drained-without-retaining
  // (Codex P2 on PR #63, and it was right). The retained-vs-arrived distinction matters because
  // \`.length\`, which is UTF-16 code units of a prefix — so the one payload whose size actually
  // matters, the monster one past the cap, was recorded at exactly the cap and every multibyte
  // payload was recorded short. A diagnostic number that is wrong precisely when it is interesting
  // is worse than no number.
  let arrivedBytes = 0;
  const buffer = Buffer.alloc(65536);
  const scratch = Buffer.alloc(65536); // reused every over-cap iteration; never retained
  const pauseSignal = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const underCap = retainedBytes < RETAINED_STDIN_CAP_BYTES;
    const target = underCap ? buffer : scratch;
    let bytesRead;
    try {
      bytesRead = readSync(0, target, 0, target.length, null);
    } catch (error) {
      if (error && error.code === "EAGAIN") {
        Atomics.wait(pauseSignal, 0, 0, 5);
        continue;
      }
      if (error && error.code === "EOF") break; // some platforms signal EOF as an error
      throw error;
    }
    if (bytesRead === 0) break;
    arrivedBytes += bytesRead;
    if (underCap) {
      chunks.push(Buffer.from(target.subarray(0, bytesRead)));
      retainedBytes += bytesRead;
    }
    // else: draining to EOF without retaining — target === scratch, its content is discarded.
  }
  return {
    text: Buffer.concat(chunks).toString("utf8"),
    truncated: retainedBytes >= RETAINED_STDIN_CAP_BYTES,
    arrivedBytes,
  };
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

// SHOULD-FIX 3 (round-5 coordinator review): a spawn failure is NOT "Monet has no opinion" — it
// means the hook itself is broken (most likely the node/monet paths baked in at \`monet install\`
// time have gone stale, e.g. an nvm reinstall moved or removed them), and unlike every other
// pass-through case, this one is silent and PERMANENT until someone notices. Still exit 0 with no
// permissionDecision (fail OPEN — never block a command because THIS hook broke, the same "never
// fail closed on an unknown" posture gate-cli.ts's own runGate applies to itself), but ALSO
// surface it on the user's channel via systemMessage (a universal field independent of
// hookSpecificOutput/permissionDecision, hooks.md:771: "Warning message shown to the user") so the
// breakage does not sit silent forever.
function emitSpawnFailureWarning() {
  emit({
    systemMessage:
      "Monet gate hook could not get an answer from \`monet gate\` (the path recorded at install " +
      "time is stale, and the \`monet\` on PATH either failed to spawn or predates the gate " +
      "command) — no gate rules are being enforced for this command. Update monet and re-run " +
      "\`monet install\` to fix this.",
  });
}

// BLOCKER 2 FIX (round-5 coordinator review): additionalContext must NOT be paired with
// permissionDecision:"defer" — hooks.md:1542 states additionalContext is "Ignored when
// permissionDecision is 'defer'", which made outcome 20 (advisory-inject) a complete no-op under
// the old code, in every session, interactive or not. The corrected shape omits permissionDecision
// entirely: hooks.md:764 says hookSpecificOutput's only REQUIRED field is hookEventName; the
// canonical "Add context for Claude" example (hooks.md:820-829) shows exactly hookEventName +
// additionalContext with NO decision key alongside it; and PreToolUse is explicitly among the
// events that section names the reminder applying to (hooks.md:831-836: "PreToolUse, PostToolUse,
// PostToolUseFailure, and PostToolBatch: next to the tool result"). Omitting permissionDecision
// means Monet has no enforcement opinion here either — the normal permission flow still decides
// allow/ask/deny on its own; the advisory rides alongside it, never overriding it.
// THE TIMING SENTENCE LIVES HERE, NOT IN \`monet gate\` (Codex P2 on PR #58, and it was right).
// Whether an advisory reaches the agent before or after the act is a property of THIS host's hook
// contract, and the gate is host-agnostic by the ARCHITECTURE note at the top of this file. The
// claim is true through this wrapper — hooks.md:831-836 puts additionalContext "next to the tool
// result", and the emit below carries no permissionDecision, so the call proceeds — and would be
// false through a preflight caller of the same gate. So the adapter that knows the timing states
// it, and the payload it wraps stays silent on the question.
// DELIVERY NAMES ITS MOMENT (invariant 03). The moment id rides along so that when the agent
// calls \`stage_lookup\`, the read joins to the exact interception that prompted it, rather than
// being counted against an unrelated total. ONE SENTENCE AND AN ID, because this text is read by a
// model on every governed tool call: minimization governs delivery, so it carries identity and an
// instruction and never rule content.
//
// THE SENTENCE IS SELF-CONTAINED, AND THAT IS MEASUREMENT RATHER THAN POLISH. It used to read
// "Pass momentId X to stage_lookup" — an imperative that, read on its own, never says what to look
// up. Whether the agent actually makes that call decides whether Received gets measured at all, and
// a half instruction lowers the call rate. The failure would not look like a defect either: it
// surfaces as unjoinableReads rising, which has a benign normal case.
//
// IT REFERS TO THE STAGES NAMED ABOVE WITHOUT REPEATING THEM — they are already in this payload,
// and re-sending them is context paid twice — and it says "on each call" rather than pairing them:
// a moment has ONE id and can match SEVERAL stages, so any phrasing implying a one-to-one pairing
// would be wrong. The deny path carries the identical sentence for the identical reason.
function emitAdvisory(context, momentId) {
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        context +
        "\\nThis advisory cannot intervene before the call: a PreToolUse advisory reaches you beside " +
        "the tool result, not before it. Whether the call ran is decided by the normal permission " +
        "flow, which this hook leaves alone. Read the stages above before your next action at them." +
        "\\nWhen you look those stages up with stage_lookup, pass momentId " + momentId + " on each call.",
    },
  });
}

// Deny log (boundary statement item 6) — a plain line a human can tail. NOT the only record of a
// deny any more: the same deny is a governed moment with disposition "blocked", carrying the stage
// and the rule ids this line does not. Whether this file is still worth keeping is an open
// question — see buildWrapperScript's own comment (install-cli.ts) for both sides of it.
function appendDenyLine(circleForJournal, firstStdoutLine) {
  try {
    // NIT (round-5 coordinator review): mode supplied unconditionally on the ONE openSync call —
    // the old code's second, mode-less fallback call (reached whenever the first call threw, for
    // ANY reason) could create this file at the process umask's default mode instead of 0600. One
    // call, one mode, no gap; the outer catch below still absorbs a genuine failure either way.
    const fd = openSync(DENY_LOG_PATH, "a", 0o600);
    writeSync(fd, \`\${new Date().toISOString()}\\t\${circleForJournal}\\t\${firstStdoutLine}\\n\`);
    closeSync(fd);
  } catch {
    // Never let a journal-append failure block or crash the hook's own decision.
  }
}

// -- The governed-moment spool ---------------------------------------------------------------
//
// A COPY, ON PURPOSE, AND HALF OF A TWO-PROCESS CONTRACT. This block duplicates
// packages/core/src/moment-spool.ts, and the path below duplicates getMomentSpoolPath() in
// packages/cli/src/db/index.ts (getMomentSpoolPath), for the reason a generated script always has: a
// generated standalone script can import nothing. THE COPIES MOVE TOGETHER -- a change to the
// record shape, the format version, or the two path rungs must land in all of them in the same
// commit, or two writers put two shapes in one file and every count over it is wrong.
//
// THE CONTRACT WITH \`monet gate\` (gate-cli.ts, spoolGovernedMoment -- stated there too, in full):
//   1. THIS script mints the moment id and forwards it in MONET_MOMENT_ID, along with the host's
//      tool_use_id in MONET_TOOL_USE_ID, which only this script ever sees.
//   2. When \`monet gate\` IS spawned, IT writes the interception record -- it is the only party
//      that knows the matched stage and the rule identity. This script writes none.
//   3. This script writes an interception ONLY when it never spawns the gate at all: a foreign
//      tool, an unparseable payload, a truncated one. Those are recorded \`ungoverned\`, which is
//      invariant 02 landing on exactly the cases it was written for.
//   4. Exactly one writer per moment on every normal path. Where both ever write about one moment,
//      the fold merges them, and THAT MERGE DEPENDS ON NULL MEANING "NOT OBSERVED": the ledger
//      upserts COALESCE(existing, excluded) per column, so a real value fills what an earlier
//      partial record left null and never overwrites what was already observed. A writer that
//      emitted a placeholder instead of null would silently win that merge and bury the real value.
//
// NO DEFENSIVE SKELETON. When the gate IS spawned and dies before writing, the right record is no
// interception, an orphan outcome, and an \`unobserved-interception\` loss -- which the fold
// produces on its own. A skeleton written "just in case" would turn every gate crash into a moment
// that looks observed and is empty, which is a verdict standing where the value is not known.
const MOMENT_SPOOL_PATH = join(MONET_STORAGE_DIR, "moments.jsonl");
const MOMENT_SPOOL_FORMAT = 1;
const MOMENT_ACTION_RENDERING_MAX_CHARS = 2048;

// LAZY, so a governed tool call that spools nothing here leaves no run-start behind. The run is
// this process's lifetime; its sequence starts at 0 with the run-start record itself, so a run
// whose declaration is the append that failed reports a hole at 0 rather than an unknown role.
let momentRun = null;
let pendingRunStart = null;
function ensureMomentRun() {
  if (momentRun !== null) return momentRun;
  momentRun = { runId: randomUUID(), seq: 0 };
  // HELD, NOT WRITTEN YET. A hook invocation is one run of exactly two records — this declaration
  // and the single interception or outcome that follows it — so the two are emitted in ONE write
  // below. If the second append is the one that fails (a disk that fills between two writes), the
  // old shape left a run-start with nothing after it: a run that is merely SHORT, which no sequence
  // gap can expose because a hole is only visible when a record follows it. Writing both together
  // means either the whole run lands or none of it does, which removes that orphan case entirely.
  //
  // It does NOT make the loss detectable — a run that never wrote a byte is invisible either way,
  // and that limit is stated in the spool's own header. It removes the WORSE state: a record that
  // says a run existed while the thing it was recording is gone.
  pendingRunStart = { kind: "run-start", writerRole: "host-hook", at: new Date().toISOString() };
  momentRun.seq = 1; // the declaration owns seq 0, whether or not it has reached the disk yet
  return momentRun;
}

// THE SEQUENCE NUMBER IS CONSUMED BEFORE THE WRITE IS TRIED, never after. Every failure here is
// swallowed -- instrumentation may not fail a user's tool call -- and the consumed-but-unwritten
// number is precisely what makes that swallow visible to the fold later.
function appendMomentRecord(body) {
  const run = momentRun;
  if (run === null) return;
  const seq = run.seq;
  run.seq = seq + 1;
  try {
    let payload = "";
    if (pendingRunStart !== null) {
      payload += JSON.stringify(Object.assign({ v: MOMENT_SPOOL_FORMAT, runId: run.runId, seq: 0 }, pendingRunStart)) + "\\n";
      pendingRunStart = null;
    }
    payload += JSON.stringify(Object.assign({ v: MOMENT_SPOOL_FORMAT, runId: run.runId, seq: seq }, body)) + "\\n";
    const fd = openSync(MOMENT_SPOOL_PATH, "a", 0o600);
    try {
      writeSync(fd, payload);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Total. The hole this leaves is the record.
  }
}

// Identity always, rendering bounded. Kept textually in sync with core's own renderAction.
function renderMomentAction(action) {
  // NO ACTION MEANS NO OBSERVATION OF ONE — all four fields go null together, never a hash of ""
  // and a length of 0, which downstream would read as a real, empty action. Mirrors core.
  if (action === null) {
    return { actionSha256: null, actionRendering: null, actionChars: null, actionClipped: null };
  }
  const clipped = action.length > MOMENT_ACTION_RENDERING_MAX_CHARS;
  return {
    actionSha256: createHash("sha256").update(action).digest("hex"),
    actionRendering: clipped ? action.slice(0, MOMENT_ACTION_RENDERING_MAX_CHARS) : action,
    actionChars: action.length,
    actionClipped: clipped,
  };
}

// A moment nothing could evaluate. \`ruleIds\` and \`deliveredRuleIds\` are NULL rather than [] --
// [] would say the gate looked and found nothing bound, and on these paths the gate never ran.
function pinnedCircleArg() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--circle");
  return at >= 0 && typeof args[at + 1] === "string" ? args[at + 1] : null;
}

function toolUseIdOf(hookInput) {
  return typeof hookInput.tool_use_id === "string" && hookInput.tool_use_id.length > 0 ? hookInput.tool_use_id : null;
}
function sessionIdOf(hookInput) {
  return typeof hookInput.session_id === "string" && hookInput.session_id.length > 0 ? hookInput.session_id : null;
}

function spoolUngovernedMoment(momentId, toolUseId, sessionId, surface, action) {
  ensureMomentRun();
  appendMomentRecord(Object.assign(
    {
      kind: "interception",
      momentId: momentId,
      at: new Date().toISOString(),
      toolUseId: toolUseId,
      // Only what this install pinned on its own command line. With no --circle there is nothing to
      // record, and null says that rather than guessing at the project a shared spool is serving.
      circle: pinnedCircleArg(),
      sessionId: sessionId,
      surface: surface,
      stageId: null,
      ruleIds: null,
      disposition: "ungoverned",
      deliveredRuleIds: null,
    },
    renderMomentAction(action),
  ));
}

// The outcome half, written by the PostToolUse invocation -- a DIFFERENT PROCESS from the one that
// opened the moment, which is the whole reason this record is keyed by the host's tool_use_id
// rather than by a moment id it has no way to know. The fold resolves it.
function spoolMomentOutcome(toolUseId, outcomeText, outcomeStatus) {
  ensureMomentRun();
  appendMomentRecord({
    kind: "outcome",
    momentId: null,
    toolUseId: toolUseId,
    outcomeStatus: outcomeStatus,
    outcomeAt: new Date().toISOString(),
    outcomeSha256: createHash("sha256").update(outcomeText).digest("hex"),
  });
}

// ── Host tool names are HOST VARIABLES, never constants (monet-client#58, 2026-08-03) ─────────
//
// THE INCIDENT THIS EXISTS TO PREVENT A REPEAT OF: Claude Code renamed its delegation tool from
// \`Task\` to \`Agent\`. The settings.json matcher \`Task\` kept matching those dispatches (harness-side
// aliasing), so this hook was still invoked on every delegation — but the guard below spelled
// \`"Task"\` as a literal and returned before ever spawning the gate. The whole delegation surface
// was invoked-but-inert for months, and every observable stayed byte-identical to healthy silence.
// Measured, cc 2.1.220: \`Agent\` payload 0.02s (node startup only) vs 0.08s with tool_name flipped
// to \`Task\` vs 0.09s for a direct \`monet gate\`.
//
// So: every host tool name this wrapper recognizes enters through THIS ONE TABLE, and nothing
// downstream of it ever compares against a host spelling again. Host spelling in, Monet surface
// out. Adding a host's new spelling for a surface we already gate is a one-line change here.
//
// WHY \`Agent\` MAPS TO THE SURFACE NAMED "Task": the surface name is what this wrapper prefixes the
// action context with, so it is also what every declared pattern spells (\`Task:verifier ...\`).
// Canonicalizing at this boundary keeps every already-declared rule matching with NO store
// migration, and keeps the host variable confined to the one adapter that faces the host — monet
// gate and the engine behind it never see a host spelling at all.
const SURFACE_BASH = "Bash";
const SURFACE_DELEGATION = "Task";
const HOST_TOOL_SURFACES = {
  Bash: SURFACE_BASH,
  Task: SURFACE_DELEGATION, // hosts predating the rename, and the alias the current host still honors
  Agent: SURFACE_DELEGATION, // cc 2.1.220's actual dispatched tool_name
};

/**
 * Host tool name → the Monet surface it belongs to, or null when we do not gate it.
 * hasOwnProperty, not a bare index: \`tool_name\` is attacker-adjacent host input, and a bare lookup
 * of "constructor" or "toString" on an object literal returns a FUNCTION, which is truthy.
 */
function surfaceForHostTool(toolName) {
  if (typeof toolName !== "string") return null;
  if (!Object.prototype.hasOwnProperty.call(HOST_TOOL_SURFACES, toolName)) return null;
  return HOST_TOOL_SURFACES[toolName];
}

// BLOCKER 1 FIX (round-5 coordinator review): every early \`return\` below is deliberate silence —
// no emit() call, nothing on stdout — for a case where Monet has no decision to report: malformed
// hook input, a tool_name outside the gated set (defense in depth; the settings.json matchers this
// command writes already name exactly that set), no tool_input.command, or (the switch's own
// default case) monet gate's own silence/stage-hit-no-rules outcomes or any exit code this switch
// does not otherwise recognize. See this file's own top comment for the full hooks.md:148 citation
// on why this — not permissionDecision:"defer" — is the correct "no opinion" idiom in every mode.
//
// EVERY ONE OF THOSE EARLY RETURNS IS AN OUTCOME, not an exemption from recording — the §0
// incident was undiagnosable precisely because a declining guard left no trace. The three that
// never reach \`monet gate\` at all record themselves as \`ungoverned\` governed moments before
// returning (see spoolUngovernedMoment), and every path that DOES reach the gate is recorded by the
// gate, which is the only party that knows the stage and the rule ids. So no exit here is silent,
// and \`decide\` returns nothing: the record is written where the fact is known, not carried back
// to a caller to be logged.
function decide(stdin) {
  // MINTED HERE, WITHOUT THE STORE (invariant 07), and before anything can decline: every path
  // below either forwards this id to \`monet gate\` (which writes the interception) or records an
  // \`ungoverned\` interception against it here. A path that returned without doing one of the two
  // would be an interception point that opened no moment, which invariant 02 forbids.
  const momentId = randomUUID();
  let hookInput;
  try {
    hookInput = JSON.parse(stdin.text);
  } catch {
    // P1-A (Codex round 4 on PR #42): a JSON.parse failure means one of two very different
    // things, and this wrapper must never treat them alike. (1) stdin.truncated === false: the
    // envelope was genuinely malformed while comfortably under the retention cap — nothing to
    // report, stays silent, exactly as BLOCKER 1's own posture above already documents. (2)
    // stdin.truncated === true: the envelope was cut off mid-string because it exceeded this
    // wrapper's own RETAINED_STDIN_CAP_BYTES — the ONE class this wrapper must never silently
    // pass through: a monster command, larger than any legitimate gate output could need, that
    // would otherwise exit 0 with empty stdout — indistinguishable from "nothing matched" — when
    // it was never even evaluated at all. \`monet gate\` is never spawned for this case: a command
    // cannot be extracted from JSON that cannot be parsed, so the decision is made from the
    // truncation signal alone. CORRECTED (host-tool-name patch): this comment used to justify the
    // no-spawn shortcut with "already knows tool=Bash authoritatively, the matcher is Bash-only",
    // which stopped being true the moment the delegation surface was gated alongside Bash — the
    // shortcut never actually needed it. What carries the conclusion is the second half alone: the
    // payload exceeded a bound far past the gate's own 4 MiB threshold, so no spawn is needed to
    // reach that conclusion. Short-circuits to the SAME permissionDecision:"ask" shape case 40
    // uses below (never allow, never deny — nothing was actually evaluated).
    if (stdin.truncated) {
      const reason = "This command's JSON payload was too large for Monet's hook wrapper to parse safely — asking you directly.";
      emit({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason },
        systemMessage: \`Monet: \${reason}\`,
      });
      // Nothing was evaluated, and nothing COULD be: the payload naming the action is itself
      // unreadable. "unavailable" is the honest claim type — the strongest thing we can say is
      // that we could not know.
      //
      // AND THE MOMENT IS STILL RECORDED. A surface this wrapper cannot read is exactly what
      // invariant 02 means by ungoverned; leaving it out would make an uninterceptable tool call
      // indistinguishable from one that never happened. Surface and action are null because they
      // are genuinely unknown here — the envelope naming them is the thing that could not be read.
      spoolUngovernedMoment(momentId, null, null, null, null);
      return;
    }
    spoolUngovernedMoment(momentId, null, null, null, null);
    return;
  }
  if (!hookInput || typeof hookInput !== "object") {
    // Same class as the two above: parsed, but not into anything this wrapper can act on. The gate
    // is never spawned, so this is the only writer that can record the moment at all.
    spoolUngovernedMoment(momentId, null, null, null, null);
    return;
  }
  const surface = surfaceForHostTool(hookInput.tool_name);
  if (surface === null) {
    // THE §0 EVENT. This is the line whose absence let a host rename take a whole surface dark
    // while every observable stayed byte-identical to health. \`hostToolName\` is recorded verbatim
    // and unmapped ON PURPOSE: the question this answers months later is "what did the host
    // actually call it", and any normalization here would destroy the only evidence of the rename.
    // THE §0 EVENT, RECORDED AS A MOMENT TOO. The surface is the host's own name for the tool,
    // verbatim and unmapped — normalizing it would destroy the only evidence of a rename. The action is null:
    // this wrapper extracts a command only for surfaces it maps, so for an unmapped one it has not
    // observed an action at all, and rendering the raw tool_input would be inventing one.
    spoolUngovernedMoment(
      momentId,
      typeof hookInput.tool_use_id === "string" ? hookInput.tool_use_id : null,
      typeof hookInput.session_id === "string" ? hookInput.session_id : null,
      typeof hookInput.tool_name === "string" ? hookInput.tool_name : null,
      null,
    );
    return;
  }

  // Task (monet-client#56): the ONE interception that is pre-cognition rather than post — every
  // other tool call is late with respect to the agent making it, because the approach was chosen
  // and the artifact drafted before the call was formed, while a spawn CREATES the reasoner the
  // rule governs. The context is "Task:<subagent_type> <description>" and deliberately NOT the
  // brief's prompt: matching on prompt text would be guessing at what a delegation is about, which
  // is the heuristic interception the boundary statement rejects by name. A pattern names a
  // moment; it does not sniff a payload.
  let command = null;
  if (surface === SURFACE_DELEGATION) {
    const input = hookInput.tool_input && typeof hookInput.tool_input === "object" ? hookInput.tool_input : {};
    const kind = typeof input.subagent_type === "string" ? input.subagent_type.trim() : "";
    const what = typeof input.description === "string" ? input.description.trim() : "";
    // Both absent means there is nothing a pattern could match, and an empty context would parse
    // as a bare prefix rather than as a delegation. Silence is the honest VERDICT — but the moment
    // still happened, and an interception point that opens none is the omission invariant 2 forbids
    // (F5). Recorded ungoverned with a null action: nothing was evaluated, and there was no action
    // this wrapper could render.
    if (!kind && !what) {
      spoolUngovernedMoment(momentId, toolUseIdOf(hookInput), sessionIdOf(hookInput), surface, null);
      return;
    }
    command = [kind, what].filter(Boolean).join(" ");
  } else {
    command = hookInput.tool_input && typeof hookInput.tool_input.command === "string"
      ? hookInput.tool_input.command
      : null;
  }
  if (command === null) {
    // A Bash call carrying no command (F5). Same reasoning as the delegation guard above.
    spoolUngovernedMoment(momentId, toolUseIdOf(hookInput), sessionIdOf(hookInput), surface, null);
    return;
  }

  // P1-3 (Codex round 3 on PR #42): build the FULLY-PREFIXED action context OURSELVES — never
  // --tool Bash. THE BYPASS THIS CLOSES: gate-cli's --tool only synthesizes a "Tool:" prefix when
  // the raw context has NO prefix that already parses (ensureToolPrefixedContext's own first line:
  // "if (parseActionContext(rawContext).tool !== null) return rawContext" — --tool is silently
  // IGNORED whenever the context already looks prefixed). A Bash command whose text itself begins
  // with tool-name grammar — Codex's own example, "x: || true; git push --force" (bash runs the
  // force-push after the harmless "x: command not found" failure) — parses as tool "x", not
  // "Bash", so this wrapper's own --tool Bash synthesis never fires and EVERY Bash-scoped rule
  // silently fails to match: exactly the "fails open SILENTLY, not loudly" case gate-cli's own
  // ensureToolPrefixedContext exists to prevent for callers who need synthesis — but this wrapper
  // does not need synthesis at all. It resolved the SURFACE authoritatively from the host's own
  // tool_name above, so it builds the prefix directly: surface + ":" + command, verbatim
  // concatenation. This ALWAYS parses as that surface with the rest of the string as the command,
  // regardless of what the command's own text contains — the surface is one of a fixed, closed set
  // of valid tool names (never host-supplied text), so the first colon in the whole string is
  // unambiguous. gate-cli's own --tool contract stays exactly as documented for other callers
  // (general convenience, correct on its own terms); this wrapper is simply not one of them.
  //
  // NOTE the surface, NOT hookInput.tool_name: an \`Agent\` dispatch must reach the gate as
  // \`Task:...\`, because that is the spelling every declared pattern uses. Prefixing with the raw
  // host name here would swap one silent-inert failure for another — the hook would spawn the gate
  // and the gate would match nothing, which looks exactly like healthy silence too.
  const actionContext = surface + ":" + command;

  const forwardedArgs = process.argv.slice(2);
  const circleArgIndex = forwardedArgs.indexOf("--circle");
  const pinnedCircle = circleArgIndex >= 0 ? forwardedArgs[circleArgIndex + 1] : undefined;
  const gateArgs = ["gate", "--stdin", ...forwardedArgs];
  // FIX 2 (Codex round 2 on PR #42): spawnSync's DEFAULT maxBuffer is ~1 MiB. A deny whose stdout
  // (the rule's own text/reason) or a gate whose stderr (diagnostics) exceeds that dies ENOBUFS
  // with no \`status\` at all — indistinguishable from a genuine spawn failure to the check right
  // below, so BOTH attempts (baked path, then PATH fallback) would "fail" this way and a REAL DENY
  // gets silently downgraded to the spawn-failure warning instead of enforced. Declaration content
  // (rule text/reason) is capped well under this at declare time, so 16 MiB is far past any
  // legitimate gate output — this is headroom, not an invitation to grow past it. If ENOBUFS
  // somehow still fires, the existing loud fail-open warning (emitSpawnFailureWarning) is still
  // the honest posture: better a visible warning than a silently lost deny.
  const MAX_BUFFER = 16 * 1024 * 1024;

  // THE TWO-PROCESS CONTRACT, in one line. MONET_MOMENT_ID makes the gate the writer of this
  // moment's interception (it is the only party that knows the stage and the rule ids);
  // MONET_TOOL_USE_ID hands it the host's own key for the tool call, which only this process ever
  // sees and which is what lets the PostToolUse invocation's outcome be joined back at fold time.
  //
  // ENV VARS, NEVER CLI FLAGS, deliberately: an older \`monet\` on PATH (the fallback spawn below
  // can find one) would reject an unknown flag as a usage error and the hook would report a broken
  // install instead of gating. An unknown env var has been ignored by every version there has
  // ever been.
  const gateEnv = Object.assign({}, process.env, {
    MONET_MOMENT_ID: momentId,
    MONET_TOOL_USE_ID: typeof hookInput.tool_use_id === "string" ? hookInput.tool_use_id : "",
    // F6: only this process ever sees the session id, and it was being discarded for exactly the
    // moments a gate evaluated — the ungoverned ones kept theirs, the governed ones did not.
    MONET_SESSION_ID: typeof hookInput.session_id === "string" ? hookInput.session_id : "",
  });
  const spawnOpts = { input: actionContext, encoding: "utf8", maxBuffer: MAX_BUFFER, env: gateEnv };

  let result = spawnSync(MONET_EXEC, [MONET_SCRIPT, ...gateArgs], spawnOpts);
  if (result.error || typeof result.status !== "number") {
    // SHOULD-FIX 3: retry once via a bare \`monet\` resolved from the CURRENT shell's PATH before
    // giving up — self-heals the common case where the paths baked in at \`monet install\` time
    // went stale (e.g. an nvm reinstall) but some \`monet\` is still reachable, instead of a
    // silent, permanent no-gate regression.
    result = spawnSync("monet", gateArgs, spawnOpts);
  }
  if (result.error || typeof result.status !== "number") {
    emitSpawnFailureWarning();
    // The record gets it too (F5). This comment already claimed as much — "a permanently-broken
    // install is precisely a condition that otherwise persists unnoticed" — with nothing under it
    // that wrote anything, so it persisted unnoticed. The gate never ran, so nobody looked:
    // ungoverned, with the action recorded because here we DO know what it was.
    spoolUngovernedMoment(momentId, toolUseIdOf(hookInput), sessionIdOf(hookInput), surface, actionContext);
    return;
  }

  const stdout = (result.stdout || "").trim();
  const firstLine = stdout.split("\\n")[0] || "";

  switch (result.status) {
    case 30: {
      appendDenyLine(pinnedCircle || "(unresolved — user-global install; see monet gate's own stderr)", firstLine);
      // "deny" (hooks.md:1539-1540): permissionDecisionReason is shown to Claude at the moment of
      // refusal. systemMessage ALSO carries it (a universal field, hooks.md:771, "shown to the
      // user") — the boundary statement's item 4 requires every blocking fire to surface on the
      // USER's channel too, not only the agent's, so this is not optional duplication.
      const reason = stdout || "Blocked by a Monet gate rule.";
      // P2-8 (Codex round 3 on PR #42): monet gate's OWN stderr (the resolved circle, any advisory
      // that also fired alongside the deny, and — the specific case this fix targets — the
      // mirror's age and repair instruction on an offline, possibly-stale cached deny) was
      // captured in \`result\` all along but silently dropped here. A user blocked by a STALE
      // cached deny never saw the staleness or the repair command (\`monet start\` / \`monet
      // install\`) unless they separately ran \`monet gate\` by hand — the boundary statement's own
      // recoverability promise is only real if it reaches the person actually blocked, not just a
      // CLI stderr stream nobody watches. Append every "monet gate:"-prefixed diagnostic line to
      // systemMessage, after the reason (permissionDecisionReason stays reason-only — Claude gets
      // the refusal itself; the user gets the refusal PLUS the operational context).
      const diagnosticLines = (result.stderr || "")
        .split("\\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("monet gate:"));
      const systemMessage = diagnosticLines.length > 0 ? [reason, ...diagnosticLines].join("\\n") : reason;
      // DELIVERY NAMES ITS MOMENT ON THE DENY PATH TOO (invariant 3). This carried the blocking
      // rule ids and an instruction to run stage_lookup, but no moment id — so the read it asked
      // for landed with moment_id: null and Received was structurally unreachable for every
      // blocking rule. permissionDecisionReason is the field the docs say is shown to Claude on a
      // deny, so the id rides there rather than in systemMessage, which the user sees instead.
      emit({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason + "\\nWhen you look those stages up with stage_lookup, pass momentId " + momentId + " on each call.",
        },
        systemMessage,
      });
      // ENFORCED, RECORDED RATHER THAN ASSUMED (monet#37). The conformance pass reads an absent
      // \`enforced\` as true, so every hook-path deny was verdicted \`changed\` on a default the record
      // never stated — and the guard meant to catch an unenforced deny could only ever fire on the
      // one mouth that writes the field, which is not this one.
      //
      // WHAT THIS CLAIMS, exactly: that THIS mechanism refused the call — the \`permissionDecision:
      // "deny"\` emitted immediately above. It is NOT a claim about the host's internals; \`emit\` is a
      // one-way write to stdout and nothing here reads an acknowledgment back. That is the same
      // scope \`enforced: false\` already carries on the stage-lookup mouth, where it means "a
      // blocking rule was delivered and this mechanism stopped nothing".
      return;
    }
    case 40: {
      // "ask" (hooks.md:1539) — the protocol's own escalate-to-the-human value, distinct from
      // allow/deny. overflow-ask must NEVER become allow (gate-cli.ts's own contract) or deny
      // (nothing was actually evaluated) — "ask" is the only honest third option.
      const reason = "This command is too large for Monet's offline gate to evaluate safely — asking you directly.";
      emit({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason },
        systemMessage: \`Monet: \${reason}\`,
      });
      // The gate read the context and refused to judge it. Nothing was evaluated, so nothing is
      // known about whether a rule governs this act.
      return;
    }
    case 20:
      emitAdvisory(stdout, momentId);
      return;
    case 1:
      // RECHECK FINDING (round-5 reviewer, new defect in the SF3 fix): exit 1 is gate-cli's USAGE
      // ERROR — nothing was evaluated — and this wrapper's own invocation is well-formed, so in
      // practice exit 1 means the \`monet\` that answered predates the gate command entirely (the
      // reviewer reproduced it against a real older global install: "unknown command 'gate'",
      // exit 1). That is exactly the stale-install scenario SF3 exists to make LOUD, reached
      // through the PATH fallback that spawns fine — lumping it into the silent default: below
      // made the warning unreachable on any machine with an older global monet, the most common
      // machine there is. Same fail-open posture, same user-visible warning as a spawn failure.
      emitSpawnFailureWarning();
      // An older monet with no gate subcommand: spawned fine, refused it, evaluated
      // nothing (F5). Same reasoning as the spawn-failure branch above.
      spoolUngovernedMoment(momentId, toolUseIdOf(hookInput), sessionIdOf(hookInput), surface, actionContext);
      return;
    default: {
      // R4: WHATEVER LANDS HERE OPENS A MOMENT. The gate emits only 0/1/10/20/30/40 today, so an
      // unrecognized code is unreachable — which is exactly the assumption that rots, and a branch
      // that records nothing is the silently-absent case this design forbids. Recorded before the
      // fail-open analysis below so no path out of this switch can skip it; a later spool call for
      // the same moment merges by first-write-wins rather than duplicating.
      if (result.status !== 0 && result.status !== 10) {
        spoolUngovernedMoment(momentId, toolUseIdOf(hookInput), sessionIdOf(hookInput), surface, actionContext);
      }
      // P1-A (Codex round 1 on PR #42): 0 (silence) and 10 (stage-hit-no-rules) both land here —
      // but monet gate ALSO answers exit 0 when it fails OPEN because the mirror is missing,
      // malformed, or unreadable (gate-cli.ts's own GATE_FAIL_OPEN_MARKER lines — the same exit
      // code as genuine silence, distinguished only by stderr). Without this check, a fresh
      // install (hook wired, no \`monet start\` session has EVER run to materialize the mirror) is
      // INDISTINGUISHABLE from "nothing matched" — the one state every new user passes through
      // looked silently, invisibly wired. Grep the CAPTURED stderr for the marker baked in above;
      // present → the fail-open is real and gets a systemMessage (still no permissionDecision —
      // Monet genuinely has no enforcement opinion on THIS command either way, mirror or no
      // mirror); absent → genuine silence, stdout stays completely empty as before. Any OTHER
      // code this switch did not anticipate falls through the same silent path, matching
      // gate-cli.ts's own "never fail closed on an unknown" posture one layer further out.
      const failOpenLines = (result.stderr || "")
        .split("\\n")
        .filter((line) => line.includes(GATE_FAIL_OPEN_MARKER));
      if (failOpenLines.length > 0) {
        emit({ systemMessage: failOpenLines.join("\\n").trim() });
        // A fail-open is NOT silence, and the record is the one place that difference survives: the
        // host saw exit 0 either way. "unavailable" says it plainly — no rule set was consulted, so
        // nothing is known about whether this act is governed.
        return;
      }
      // Genuine silence (exit 0) or stage-hit-no-rules (exit 10) — the gate answered, and had
      // nothing to say. THIS is the line that makes normal silence distinguishable from broken
      // silence after the fact: it exists, so its absence means something.
      //
      // AND ONLY THOSE TWO (Codex P2 on PR #63, and it was right). This switch's \`default:\` catches
      // every status the cases above do not, so an exit 2 — or any code a future gate introduces —
      // was being written down as \`silent\`: a healthy evaluation that never happened. That is the
      // broken-silence ambiguity this record exists to remove, reintroduced inside the record
      // itself. The fail-open behaviour is unchanged either way; what changes is that the record
      // stops claiming to know.
      if (result.status !== 0 && result.status !== 10) {
        return;
      }
      return;
    }
  }
}

// The mouth. Arrival is witnessed BEFORE the payload is parsed and before any guard runs; the
// disposition is written on the way out, whatever the outcome — including an outcome nobody
// anticipated, which is what the catch is for. A throw that escaped here would leave an arrival
// with no disposition, and that asymmetry is itself the finding.
/**
 * THE OUTCOME HALF. A separate process from the PreToolUse that opened the moment, holding none of
 * its state — which is why the record it writes is keyed by the host's \`tool_use_id\` and resolved
 * later by the fold rather than here.
 *
 * EMITS NOTHING. The tool has already run; this hook has no opinion to offer and stays silent so
 * the result reaches the model untouched.
 */
function recordPostToolUse() {
  const stdin = readAllStdin();
  let hookInput;
  try {
    hookInput = JSON.parse(stdin.text);
  } catch {
    return;
  }
  if (!hookInput || typeof hookInput !== "object") return;
  // TWO CLOSING EVENTS, ONE PATH. The host's lifecycle fires PostToolUse after a tool call succeeds
  // and PostToolUseFailure after one fails. BOTH close a moment, because the action HAPPENED either
  // way — a failed rm -rf is at least as worth asking about as a successful one, and #60's own
  // done-when says every host tool call opens AND CLOSES a moment. Accepting only the success event
  // left every failed governed call permanently unclosed, and therefore permanently out of the ask
  // backlog, which gates on an outcome.
  //
  // The host is the authority on which event this is; the argv marker only chose the code path.
  const closingEvent = hookInput.hook_event_name;
  if (closingEvent !== "PostToolUse" && closingEvent !== "PostToolUseFailure") return;
  const toolUseId = typeof hookInput.tool_use_id === "string" && hookInput.tool_use_id.length > 0
    ? hookInput.tool_use_id
    : null;
  // NO KEY, NO RECORD. The host documents tool_use_id as nullable, and an outcome that names
  // neither a moment nor a tool call could be attached to nothing — it would become a recorded loss
  // naming nothing missing. The moment simply closes with its outcome never observed, which is a
  // state the ledger already carries honestly.
  if (toolUseId === null) return;
  // N1: HASHED OVER BOTH FIELDS, so no field name has to be guessed right. The first version took
  // the failure digest over hookInput.error alone -- an unverified name -- and every failure whose
  // detail lived elsewhere collapsed into one constant digest. A constant digest reads exactly like
  // a real observation, which is the failure this project's own principle names. Including both
  // removes the guess rather than improving it: whichever field the host actually populates lands
  // in the hash, and the other contributes null.
  //
  // The digest stays identity, never content -- nothing here stores what the tool returned.
  const outcomeValue = closingEvent === "PostToolUseFailure"
    ? {
        failed: true,
        error: hookInput.error === undefined ? null : hookInput.error,
        tool_response: hookInput.tool_response === undefined ? null : hookInput.tool_response,
      }
    : (hookInput.tool_response === undefined ? null : hookInput.tool_response);
  // KNOWN LIMIT, NOT A FIX (Codex P2). A PostToolUse envelope past this wrapper's retained-stdin cap
  // is truncated, so the parse above already failed and returned — the moment stays open and never
  // enters the question backlog. It cannot be repaired here: the outcome can only be keyed by the
  // host's tool_use_id, and on a truncated envelope that field may be past the cut. Recovering it by
  // pattern-matching a partial JSON body would be a guess about identity, which is the one thing
  // this record refuses to do. Stated here so the next reader does not mistake it for an oversight.
  let outcomeText;
  try {
    outcomeText = JSON.stringify(outcomeValue);
  } catch {
    // An outcome that cannot be serialized still HAPPENED. Recording its identity as the string
    // form keeps it observed rather than dropping the moment's closing record.
    outcomeText = String(outcomeValue);
  }
  // N2: which of the host's two closing events fired is a fact this process HOLDS, and dropping
  // it made a call that landed indistinguishable from one the remote rejected.
  spoolMomentOutcome(toolUseId, outcomeText, closingEvent === "PostToolUseFailure" ? "failed" : "ok");
}

function main() {
  // ONE SCRIPT, TWO EVENTS. The marker on argv chooses the path BEFORE stdin is read, so a
  // PostToolUse invocation never pays for reading a payload the PreToolUse path would want. The
  // payload's own \`hook_event_name\` is still checked inside, and it is the authority if the two
  // ever disagree.
  if (process.argv.indexOf(POST_TOOL_USE_FLAG) !== -1) {
    try {
      recordPostToolUse();
    } catch {
      // Never fail, delay or alter a tool call because instrumentation broke. The tool has already
      // run; the worst case here is a moment that closes outcome-unknown.
    }
    return;
  }
  const stdin = readAllStdin();
  try {
    decide(stdin);
  } catch {
    // Same fail-open posture the rest of this wrapper holds: never block a command because THIS
    // hook broke. Nothing is emitted, so the normal permission flow decides.
    return;
  }
}

main();
// FIX 2 FOLLOW-ON (Codex round 2 on PR #42, found by this fix's OWN test): process.exitCode, not
// process.exit(0) — the wrapper ALWAYS exits 0 either way (any decision rides the JSON, never the
// exit code), but process.exit() terminates IMMEDIATELY, before Node's event loop drains, and a
// LARGE emit() write (a deny whose reason is now legitimately multi-MB, per FIX 2's own raised
// maxBuffer) is asynchronous to a pipe — process.exit() right after it can truncate the write
// before the OS pipe (commonly a 64 KiB buffer) has drained, corrupting the very output FIX 2
// exists to preserve. Setting exitCode and letting the process exit naturally once the event loop
// empties waits for the pending write to complete first. No functional change for the common,
// small-output case; this only matters once FIX 2 makes a genuinely large emit() reachable.
process.exitCode = 0;
`;
}

// ── settings.json: shapes, recognition, idempotent upsert ────────────────────────────────────

export interface HookHandler {
  type: string;
  command?: string;
  /** Exec-form argument vector (hooks.md:364, :371-377) — see runInstall's own comment for why
   *  this command now always writes exec-form handlers. */
  args?: string[];
  [key: string]: unknown;
}

export interface MatcherGroup {
  matcher?: string;
  hooks: HookHandler[];
  [key: string]: unknown;
}

export interface SettingsFile {
  hooks?: {
    PreToolUse?: MatcherGroup[];
    /** Written alongside PreToolUse since the outcome half shipped; the set is installed together. */
    PostToolUse?: MatcherGroup[];
    /** The other closing event: a tool call that ran and failed still closes its moment. */
    PostToolUseFailure?: MatcherGroup[];
    [event: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Recognizes a hook handler THIS command wrote on any prior run — by whether it references the
 * FULL RESOLVED WRAPPER PATH for this machine (`~/.monet/gate-hook.mjs`), never merely the bare
 * filename.
 *
 * SHOULD-FIX 1 (round-5 coordinator review): the old check was `command.includes(WRAPPER_FILENAME)`
 * — a bare `"gate-hook.mjs"` substring match. A reviewer probe proved this deletes a USER's OWN,
 * entirely unrelated hook the moment its command string happens to reference ANY file sharing that
 * name in some OTHER directory (e.g. the user's own `~/scripts/gate-hook.mjs`, nothing to do with
 * Monet). Matching the full path closes that: a foreign hook naming a different absolute path can
 * never collide with this one, no matter what its filename is.
 *
 * Checks BOTH handler shapes because `wrapperPath` can appear in either, depending on which
 * version of this command wrote the entry being read:
 *   - Exec form (hooks.md:364, :371-377 — what THIS version of runInstall writes): the wrapper
 *     path is `args[0]` exactly; `command` itself is just an interpreter path (`process.execPath`)
 *     that changes across an nvm upgrade and is deliberately NOT part of this match.
 *   - Shell form (what an OLDER version of this command wrote, before the round-5 exec-form
 *     switch): the wrapper path is shell-quoted INSIDE the `command` string — `.includes(...)`
 *     still finds it there as a contiguous substring, since shellQuote wraps but never rewrites
 *     the path's own characters. This is what lets a pre-round-5 install upgrade in place instead
 *     of leaving a stale duplicate behind.
 *
 * Deliberately NOT an exact match on the whole command/args: the pinned `--circle` argument (or
 * its absence) changes between runs, so an exact match would never recognize an OLDER install's
 * entry as "ours" and would duplicate rather than update it.
 *
 * P2-6 (Codex round 3 on PR #42): the shell-form check below is a BOUNDARY match, not a bare
 * `.includes()` substring test. `.includes()` also matched a wrapper path that is merely a PREFIX
 * of a longer, different filename — a foreign handler referencing the user's own
 * `<wrapperPath>.backup` (e.g. a hand-made backup of an old hook) contains the full wrapper path
 * as a literal substring and was misclassified as "ours", then deleted on the next install. The
 * fix requires the path to appear as a WHOLE shell argument: immediately preceded by
 * start-of-string, whitespace, or a quote character, and immediately followed by end-of-string,
 * whitespace, or a quote character — so `'/x/gate-hook.mjs'` matches (quote-bounded) but
 * `/x/gate-hook.mjs.backup` does not (followed by `.`, not a boundary).
 */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandReferencesWrapperPathAsArgument(command: string, wrapperPath: string): boolean {
  const boundary = `(^|\\s|['"])${escapeForRegExp(wrapperPath)}($|\\s|['"])`;
  return new RegExp(boundary).test(command);
}

export function isMonetGateHandler(value: unknown, wrapperPath: string): value is HookHandler {
  if (typeof value !== "object" || value === null) return false;
  const handler = value as HookHandler;
  if (handler.type !== "command") return false;
  if (Array.isArray(handler.args)) return handler.args[0] === wrapperPath;
  return typeof handler.command === "string" && commandReferencesWrapperPathAsArgument(handler.command, wrapperPath);
}

/**
 * Idempotent upsert: strip any handler a PREVIOUS `monet install` run wrote (from every
 * PreToolUse matcher group, dropping a group left empty BY THAT REMOVAL), then add the fresh
 * handler into each GATED_TOOL_MATCHERS group — reusing one if it already exists (preserving any
 * OTHER handler already in it untouched), creating one if not. Every OTHER event, matcher group, and
 * handler in the file is carried over verbatim and in place; nothing here ever reorders or drops
 * content this command did not itself write.
 *
 * NIT (round-5 coordinator review): "dropping a group left empty by that removal" is deliberately
 * narrower than "dropping any group that ends up empty" — the old code conflated the two
 * (`survivors.length > 0` alone decided whether a group survived), which meant a group the user
 * had ALREADY left empty (`{matcher: "Foo", hooks: []}`, nothing to do with Monet) was silently
 * deleted too, even though this function never had anything of its own to remove from it. A group
 * is only ours to drop when it HELD a monet-gate handler and stripping it left zero survivors
 * (`originalHooks.length > 0 && survivors.length === 0`); a group that started empty is preserved
 * exactly as given.
 *
 * `wrapperPath` is threaded through to `isMonetGateHandler` — see that function's own comment
 * (SHOULD-FIX 1) for why recognition needs the full resolved path, not just the handler being
 * upserted.
 *
 * Returns a NEW object (via `structuredClone`) rather than mutating `settings` in place — a
 * `--dry-run` caller computes this same result purely to print it, and must not have silently
 * mutated the in-memory object it read either way.
 */
/**
 * The tool surfaces this install intercepts, as settings.json PreToolUse matchers. See
 * upsertMonetGateHook for why the list is short.
 *
 * REGEX, AND ANCHORED, BOTH DELIBERATE (host-tool-name patch, monet-client#58) — every claim here
 * is measured against cc 2.1.220 with a session-scoped `--settings` overlay of marker hooks, not
 * assumed from the docs:
 *
 *  - A matcher is matched as a REGEX, not compared as a string: a group whose matcher was
 *    `^(Bash|Task|Agent)$` received both the `Bash` and the `Agent` payloads.
 *  - The delegation surface names BOTH host spellings because the host now dispatches
 *    `tool_name: "Agent"`. Today a bare `Task` matcher still matches those dispatches through
 *    harness-side aliasing — but relying on that alias is the exact dependency that took this
 *    surface dark for months (see the wrapper's own HOST_TOOL_SURFACES comment). Naming `Agent`
 *    outright removes the dependency; naming `Task` alongside it keeps hosts predating the rename.
 *  - ONE group for the pair, not two, because two matcher groups that BOTH match fire BOTH their
 *    handlers: with separate `Task` and `Agent` groups installed, one delegation delivered the
 *    payload to each — the gate would spawn twice, advisories would inject twice, and every deny
 *    would open two governed moments for one call. The alternation fires exactly once.
 *  - ANCHORED because an unanchored `Bash` is a substring match against every tool whose name
 *    contains it — `BashOutput` among them — and each such match costs a wasted node spawn that
 *    the wrapper only ever answers with silence.
 */
export const GATED_TOOL_MATCHERS = ["^Bash$", "^(Task|Agent)$"] as const;

export function upsertMonetGateHook(settings: SettingsFile, handler: HookHandler, wrapperPath: string): SettingsFile {
  const next = structuredClone(settings ?? {}) as SettingsFile;
  const hooks = (next.hooks ?? {}) as NonNullable<SettingsFile["hooks"]>;
  next.hooks = hooks;

  hooks.PreToolUse = upsertHandlerForEvent(hooks.PreToolUse as MatcherGroup[] | undefined, handler, wrapperPath);
  // BOTH EVENTS, ONE SCRIPT. PostToolUse is what makes a moment's outcome OBSERVED rather than
  // reconstructed, and it is wired over the SAME matcher set on purpose: an outcome only means
  // something for a moment PreToolUse actually opened, so a wider set here would record outcomes
  // for tool calls no interception ever saw and manufacture losses out of the difference.
  hooks.PostToolUse = upsertHandlerForEvent(
    hooks.PostToolUse as MatcherGroup[] | undefined,
    postToolUseHandler(handler),
    wrapperPath,
  );
  // AND THE FAILURE HALF. The host closes a tool call with one of two events depending on whether
  // it succeeded, and a moment closed only on success is a moment that never closes when the
  // command fails — silently, and on exactly the calls a rule is most likely to have been about.
  // Same marker, same script, same matcher set, for the same reason PostToolUse uses it.
  hooks.PostToolUseFailure = upsertHandlerForEvent(
    hooks.PostToolUseFailure as MatcherGroup[] | undefined,
    postToolUseHandler(handler),
    wrapperPath,
  );
  return next;
}

/**
 * The same wrapper, marked so it takes its outcome path.
 *
 * EXEC FORM ONLY, and that is not a limitation this ignores: `runInstall` writes exec-form handlers
 * (`command: execPath, args: [wrapperPath, ...]`) for the tokenization reason its own comment
 * gives, so `args` is always present on a handler this command produced. A shell-form handler is
 * returned unchanged rather than string-spliced — appending to a quoted command line is exactly the
 * class of guess that produces a subtly wrong install, and a PostToolUse entry that silently did
 * not carry the marker would take the PreToolUse path and emit a decision on a tool that has
 * already run.
 */
function postToolUseHandler(handler: HookHandler): HookHandler {
  if (handler.args === undefined) return handler;
  return { ...handler, args: [...handler.args, POST_TOOL_USE_FLAG] };
}

/**
 * Replaces this command's own handlers under ONE event, leaving every other handler alone.
 *
 * Extracted so PreToolUse and PostToolUse cannot drift: the removal half in particular has to be
 * identical, or an uninstall would strip one event and leave the other pointing at a wrapper that
 * is no longer there.
 */
function upsertHandlerForEvent(
  existing: MatcherGroup[] | undefined,
  handler: HookHandler,
  wrapperPath: string,
): MatcherGroup[] {
  const cleaned: MatcherGroup[] = [];
  for (const group of existing ?? []) {
    const originalHooks = group.hooks ?? [];
    const survivors = originalHooks.filter((h) => !isMonetGateHandler(h, wrapperPath));
    if (survivors.length > 0 || originalHooks.length === 0) {
      cleaned.push({ ...group, hooks: survivors });
    }
    // else: originalHooks.length > 0 && survivors.length === 0 — every handler this group had was
    // ours; dropping it avoids leaving a pointless empty group behind.
  }

  // The Bash surface and the delegation surface, and deliberately nothing else (monet-client#56).
  // Every other tool is post-cognition — intercepting it delivers a rule to an agent that has
  // already decided — and high-frequency, which is how gate trust dies. Delegation earns its place
  // by being a juncture: the call creates the reasoner the rule governs. See GATED_TOOL_MATCHERS
  // for why the delegation matcher names two host spellings in one anchored alternation.
  for (const matcher of GATED_TOOL_MATCHERS) {
    const group = cleaned.find((g) => g.matcher === matcher);
    if (group) group.hooks = [...group.hooks, handler];
    else cleaned.push({ matcher, hooks: [handler] });
  }
  return cleaned;
}

/**
 * SHOULD-FIX 2 (round-5 coordinator review): valid JSON with the WRONG shape — `hooks` as a
 * string, `PreToolUse` as a number, a matcher group's own `hooks` as a string — all three
 * reviewer-probed and all three crashed `upsertMonetGateHook` with a raw, uninformative TypeError
 * (e.g. "preToolUse is not iterable") instead of the same clean, honest refusal an unparseable
 * file already gets. This function's whole job is to make "parses as JSON but is not a settings
 * file this command can safely reason about" and "does not parse as JSON at all" the SAME kind of
 * failure from runInstall's point of view — both refuse, neither touches the file.
 */
function validateSettingsShape(value: unknown): { ok: true; settings: SettingsFile } | { ok: false; reason: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "not a JSON object" };
  }
  const settings = value as SettingsFile;
  if (settings.hooks === undefined) return { ok: true, settings };
  if (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks)) {
    return { ok: false, reason: "`hooks` is present but not an object" };
  }
  const preToolUse = settings.hooks.PreToolUse;
  if (preToolUse === undefined) return { ok: true, settings };
  if (!Array.isArray(preToolUse)) {
    return { ok: false, reason: "`hooks.PreToolUse` is present but not an array" };
  }
  for (let index = 0; index < preToolUse.length; index++) {
    const group = preToolUse[index] as unknown;
    if (typeof group !== "object" || group === null || Array.isArray(group)) {
      return { ok: false, reason: `hooks.PreToolUse[${index}] is not an object` };
    }
    if (!Array.isArray((group as MatcherGroup).hooks)) {
      return { ok: false, reason: `hooks.PreToolUse[${index}].hooks is present but not an array` };
    }
  }
  return { ok: true, settings };
}

// ── The coverage report ───────────────────────────────────────────────────────────────────────

/**
 * The install-time coverage report (the `monet install` row: "emits the coverage
 * report naming wired and unwired surfaces (the accepted hole, stated honestly at install
 * time)"). Every "not wired" line names something real from the boundary statement's own "What it
 * CANNOT promise" section rather than staying silent about it.
 *
 * THIS IS ALSO THE GATE'S DECLARED COVERAGE BOUNDARY, and that is a load-bearing role rather than
 * documentation. The governed-moment record's invariant 02 says a surface that CANNOT be
 * intercepted is recorded as ungoverned rather than silently omitted. Applied literally to every
 * unwatched tool it would be wrong, because there are THREE categories where the design named two:
 *
 *   - governed — intercepted, and a moment opens for every call;
 *   - ungoverned BY NATURE — cannot be intercepted at all, so a per-moment record is impossible;
 *   - ungoverned BY CHOICE — could be intercepted, and this install deliberately does not.
 *
 * The third is a POLICY fact, not a per-moment fact. One record per unwatched tool call would add
 * volume and no information, and it would install a hook on every tool — the exact thing the
 * narrow matcher set exists to avoid. So it is declared ONCE, here, where anyone asking "what does
 * the gate actually see?" can read it (`monet install --dry-run` prints this without writing
 * anything). Declared absence is what invariant 02 was protecting; silent absence is what it
 * forbids.
 *
 * The by-nature set CANNOT be enumerated closed and this report must not imply otherwise: MCP tool
 * names come from whatever servers a user has configured, so the list below names the classes it
 * can and says plainly that it is open-ended.
 */
export function buildCoverageReport(): string {
  return `
Coverage report — what this install actually enforces, and what it does not:

WIRED — a governed moment opens for every one of these, including the silent ones
  Bash, via PreToolUse — every blocking/advisory rule declared against a "Bash:..." action
  context is enforced for every Bash command Claude Code runs under this hook.

  Task, via PreToolUse — a delegation is intercepted BEFORE the worker reasons, with the action
  context "Task:<subagent_type> <description>". This is the only pre-cognition interception in
  the set: every other tool call is late with respect to the agent making it, while a spawn
  creates the reasoner the rule governs. The brief's PROMPT is deliberately not in the context —
  matching on it would be guessing at what a delegation is about rather than naming a moment.

  The host's own name for this tool is a HOST VARIABLE — Claude Code dispatches it as "Agent"
  as of 2.1.220, older hosts as "Task" — and both are intercepted. "Task:" is Monet's canonical
  spelling for the surface, so that is what patterns are declared against no matter which name
  the host used; declare "Task:...", never "Agent:...".

  CAVEAT — the matcher sees only a CONTIGUOUS run of tokens: the exact spelling a pattern was
  declared from. Inserting arguments BETWEEN a pattern's own tokens breaks the match — a pattern
  seeded from "git push --force" does NOT match "git push origin main --force" ("push" and
  "--force" are no longer adjacent once "origin main" sits between them). Declare the orderings
  you fear as separate patterns.

  Bash and Task also run under PostToolUse AND PostToolUseFailure — the host closes a tool call
  with one or the other depending on whether it succeeded, and both record what the call RETURNED
  against the moment its PreToolUse opened. A failed call is closed for the same reason a
  successful one is: it ran, so whether it followed the rule is a real question. The events are
  joined by the host's own tool_use_id; a call the host gives no tool_use_id simply closes with
  its outcome never observed, recorded as unknown rather than guessed at.

  A call the gate DENIES is closed by neither, because it never ran. That moment keeps its
  interception and never receives an outcome, which is correct rather than missing: enforcement
  already settled it, and there is no action to ask about.

UNGOVERNED BY CHOICE — could be watched, deliberately is not. Declared here, once.
  - Every OTHER Claude Code tool (Read, Write, Edit, Glob, Grep, WebFetch, WebSearch,
    AskUserQuestion, ExitPlanMode, ...): no hook is installed for them, so no moment opens and
    none is recorded. Deliberate, not pending — they are post-cognition (the agent has already
    decided by the time the call is formed) and high-frequency, and noise is the fastest way to
    kill gate trust. A rule bound to one of those Tool: prefixes never fires through this install.

UNGOVERNED BY NATURE — cannot be watched at all. NOT a closed list.
  - MCP tool calls: their names come from whatever servers you have configured, so this set is
    open-ended by construction and no enumeration here can be complete.
  - Files referenced with @ in a prompt: Claude Code inserts their contents while building the
    prompt, with no tool call, so no PreToolUse hook fires for them — including hooks matching
    Read (https://code.claude.com/docs/en/hooks, "PreToolUse").
  - EndConversation: PreToolUse does not fire for it (same source).

  These three cannot produce a per-moment record even in principle. They are named so their
  absence from the record is a stated boundary rather than an unexplained silence.
NOT ENFORCEABLE — reachable effects a pattern will never catch
  - Within Bash itself: sh -c, an inline script, a shell alias or function, a short flag (-f vs
    --force), reordered arguments, or padded whitespace all reach the same effect without
    tripping a pattern — by design (boundary statement, "CANNOT promise" #1: heuristic
    interception was rejected by name). Not a gap this matcher will ever close.
  - Any host other than Claude Code (Cursor, Codex CLI, ...): this command wires Claude Code
    only — other hosts need their own adapter ("one adapter per surface" — unbuilt).
`;
}

// ── Wiring ─────────────────────────────────────────────────────────────────────────────────────

export interface InstallCliDependencies {
  homeDir(): string;
  projectDir(): string;
  /** The CLIENT's own store-aware resolver (circle.ts) — a live read is fine here; install is a
   *  one-shot command, never the hook path. Closes Codex round-2's residual offline-resolver gap
   *  by pinning the result once, at install time, rather than re-approximating it per invocation.
   *  FIX 4 (Codex round 2 on PR #42): `opts.readOnly` is --dry-run's preview mode — see circle.ts's
   *  own deriveCircle for the full contract (same resolution VALUE, no store mutation). */
  deriveCircle(projectDir: string, opts?: { readOnly?: boolean }): string;
  monetInvocation(): { execPath: string; scriptPath: string };
  /** P1-1 (Codex round 3 on PR #42): `baseDir` mirrors db/index.ts's own optional parameter —
   *  called with `target.projectDir` below so the directory created matches where `deriveCircle`
   *  (and, for a real non-dry-run install, the store it may touch) actually resolves to. */
  ensureMonetDir(baseDir?: string): string;
  setExitCode(code: number): void;
}

export function defaultInstallCliDependencies(): InstallCliDependencies {
  return {
    homeDir: () => homedir(),
    projectDir: resolveProjectDir,
    deriveCircle,
    monetInvocation: () => ({ execPath: process.execPath, scriptPath: process.argv[1] ?? "" }),
    ensureMonetDir,
    setExitCode(code) {
      process.exitCode = code;
    },
  };
}

interface InstallCommandOptions {
  project?: string;
  user?: boolean;
  dryRun?: boolean;
}

interface InstallTarget {
  settingsPath: string;
  scope: "project" | "user";
  projectDir: string;
}

/**
 * DEFAULT TARGET (flagged prominently — this slice's report; open question for the lead):
 * PROJECT scope, and specifically `.claude/settings.local.json` — NOT the shareable
 * `.claude/settings.json` sibling the hooks doc also documents ("Hook locations": user /
 * project / project-local). Reasoning:
 *
 *   1. CIRCLE-PIN CORRECTNESS. A project-scoped install bakes ONE resolved --circle into the
 *      hook command (see below) — correct because this hook only ever fires inside THIS
 *      project's own Claude Code sessions. A user-global hook fires for EVERY project on the
 *      machine; baking in one fixed circle there would silently apply the WRONG circle to every
 *      project except the one `monet install` happened to run from. So project-scoped is the
 *      only shape that makes circle-pinning (Codex round 2's own closed gap) safe by construction
 *      — this is the deciding argument, not a preference.
 *   2. MACHINE-SPECIFIC CONTENT. The hook command embeds an ABSOLUTE, machine-local path (this
 *      monet installation's own resolved invocation — see monetInvocation()). Writing that into
 *      the SHAREABLE `.claude/settings.json` (committed to the repo, per the doc's own "Shareable
 *      (commit to repo)" note) would almost certainly be wrong on a teammate's machine the moment
 *      they pull it. `.claude/settings.local.json` is documented as gitignored and machine-local
 *      — the one project-scope file this command's own output is actually safe to write.
 *
 * `--user` switches to `~/.claude/settings.json` instead (global, every project). When chosen,
 * NO --circle is baked in (see runInstall) — the wrapper forwards no --circle argument, and
 * `monet gate`'s own default resolution (folder/remote-derived, reading CLAUDE_PROJECT_DIR which
 * Claude Code sets per invocation — see gate-cli.ts) runs per invocation instead. That is
 * correct for this scope and the only honest choice; it is also narrower than a project-scoped
 * pin (round 2's residual gap stays open for --user installs), which is exactly the tradeoff
 * `--user` is choosing.
 */
function resolveInstallTarget(options: InstallCommandOptions, deps: InstallCliDependencies): InstallTarget {
  const projectDir = options.project ? path.resolve(options.project) : deps.projectDir();
  if (options.user) {
    return { settingsPath: join(deps.homeDir(), ".claude", "settings.json"), scope: "user", projectDir };
  }
  return { settingsPath: join(projectDir, ".claude", "settings.local.json"), scope: "project", projectDir };
}

/**
 * FIX 5 (Codex round 2 on PR #42): the wrapper and settings.json were being TRUNCATED IN PLACE
 * (`writeFileSync` straight onto the final path) — a crash mid-write, or a concurrent reader
 * (Claude Code itself, or another `monet install` run) observing the file at exactly the wrong
 * moment, could see a partially-written, invalid file: a truncated settings.json the NEXT hook
 * invocation chokes on, or a half-written wrapper script.
 *
 * Mirrors @team-monet/core's own `materializeGateMirror` atomic-write shape EXACTLY (gates.ts,
 * around its own `const tmp = join(dir, \`.${basename(path)}.${process.pid}.${Date.now()}.
 * ${randomUUID()}.tmp\`)` / `writeFileSync(tmp, data, { flag: "wx", ... })` / `renameSync(tmp,
 * path)` sequence) — the identical write-then-rename mechanism this client's own gate mirror
 * already depends on, for the identical reason: a hidden, pid+timestamp+UUID-suffixed tmp file in
 * the SAME directory as the final RESOLVED target (same-directory is what makes the rename atomic
 * — a cross-filesystem rename is not one), created with EXCLUSIVE creation (`wx` — fails on any
 * existing path at that name, without following a symlink), then renamed onto the final path. A
 * rename is a single filesystem operation: a reader sees either the OLD complete file or the NEW
 * complete file, never a partial write.
 *
 * P2-5 (Codex round 3 on PR #42) — SYMLINK-AWARE: if `targetPath` is a symlink, resolve it via
 * `realpathSync` FIRST and write through to the LINK TARGET instead — both the tmp file's own
 * directory and the final `renameSync` land there, never at the symlink's own path. Refusing to
 * touch a symlinked settings file would be hostile to a common, deliberate dotfiles setup (the
 * real file lives in a dotfiles repo; `~/.claude/settings.local.json` is a symlink to it) — the
 * user would have to re-run this command with `--dry-run` just to discover their own symlink
 * blocked it. Writing through instead leaves the user's symlink completely untouched (it already
 * points at the right inode-holding path; only THAT path's content changes) — this is the exact
 * property a rename-onto-an-existing-path already has (the core's own comment on this pattern:
 * "a rename onto an existing path replaces its inode outright... regardless of what it was before"
 * — replacing the REAL file's inode, not the symlink's).
 *
 * P2-4 (Codex round 3 on PR #42) — MODE PRESERVATION: `mode` is now two DIFFERENT things depending
 * on whether the caller passes it:
 *   - a specific number (the wrapper's own call, always `0o755`): FORCED, unconditionally — a
 *     generated, executable script must always end up executable regardless of what a user might
 *     have hand-chmod'd it to; there is nothing here worth "preserving".
 *   - omitted (the settings.json call): the file's OWN EXISTING mode is preserved when it already
 *     exists (a user who chmod'd their settings file `0600` for extra privacy must not silently
 *     have it widened back to the process umask's default the next time `monet install` re-runs);
 *     Node's own `writeFileSync` default (`0o666`, subject to umask) applies only when the file is
 *     genuinely new. `statSync` follows a symlink on its own (no separate `lstatSync` needed), so
 *     this already reads the REAL file's mode once `resolvedPath` has been resolved above.
 *
 * On any failure (including the exclusive-create itself), the tmp file is best-effort cleaned up
 * and the ORIGINAL error is rethrown — this function adds a safety property, it does not change
 * runInstall's existing behavior of letting a write failure propagate to the top-level handler.
 *
 * `verifyBeforeRename`, when supplied, runs after the complete temporary file is durable enough for
 * this helper's existing contract and immediately before the rename. A thrown verification error
 * aborts replacement and follows the same cleanup/rethrow path. Materialization uses this as a
 * best-effort snapshot compare-and-swap; existing install callers omit it and are unchanged.
 */
export function atomicWriteFile(
  targetPath: string,
  data: string,
  mode?: number,
  verifyBeforeRename?: () => void,
): void {
  let resolvedPath = targetPath;
  try {
    resolvedPath = realpathSync(targetPath);
  } catch {
    // Not a symlink, or does not exist yet — write at targetPath directly, as before.
  }

  let effectiveMode = mode;
  if (effectiveMode === undefined) {
    try {
      effectiveMode = statSync(resolvedPath).mode & 0o777;
    } catch {
      // Genuinely new — no existing mode to preserve; falls through to writeFileSync's own default.
    }
  }

  const dir = dirname(resolvedPath);
  const tmp = join(dir, `.${basename(resolvedPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, data, effectiveMode !== undefined ? { flag: "wx", mode: effectiveMode } : { flag: "wx" });
    verifyBeforeRename?.();
    renameSync(tmp, resolvedPath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup — matches materializeGateMirror's own posture; the ORIGINAL error is
      // what the caller needs to see, not a secondary cleanup failure.
    }
    throw error;
  }
}

export function runInstall(
  options: InstallCommandOptions,
  deps: InstallCliDependencies = defaultInstallCliDependencies(),
): void {
  const target = resolveInstallTarget(options, deps);

  // P2-C (Codex round 4 on PR #42): an EXPLICIT --project target must exist and be a directory
  // BEFORE any side effect below (existingSettings' own read is harmless, but ensureMonetDir a few
  // lines further down is a real mkdirSync) — checked only for options.project, never for the
  // DEFAULT target (deps.projectDir(): cwd or an env override a host already resolved), which
  // needs no such check, per resolveInstallTarget's own doc comment. Without this, `monet install
  // --project /path/typo` silently mkdirSync-CREATED the entire bogus path as a side effect of the
  // first thing that touched it (ensureMonetDir), for what was almost certainly an operator typo.
  if (options.project !== undefined) {
    const projectExists = existsSync(target.projectDir);
    if (!projectExists || !statSync(target.projectDir).isDirectory()) {
      console.error(
        `monet install: --project ${target.projectDir} does not exist or is not a directory — ` +
          `refusing to create it. Pass an existing project directory.`,
      );
      deps.setExitCode(1);
      return;
    }
  }

  let existingSettings: SettingsFile = {};
  if (existsSync(target.settingsPath)) {
    const raw = readFileSync(target.settingsPath, "utf8");
    let parsed: unknown;
    try {
      parsed = raw.trim().length === 0 ? {} : JSON.parse(raw);
    } catch (error) {
      // REFUSE, NEVER CLOBBER: an unparseable settings file might carry hand-edited content this
      // command cannot safely reason about preserving — the same "never fail closed on an
      // unknown... EXCEPT here fail-closed is exactly right" logic doctor/repair already apply to
      // their own store precondition failures.
      console.error(
        `monet install: ${target.settingsPath} is not valid JSON (${(error as Error).message}) — ` +
          `refusing to touch it. Fix or remove the file by hand, then re-run.`,
      );
      deps.setExitCode(1);
      return;
    }
    // SHOULD-FIX 2 (round-5 coordinator review): valid JSON but the WRONG SHAPE (hooks as a
    // string, PreToolUse as a number, a group's own hooks as a string) is just as unsafe to
    // blindly upsert into as invalid syntax — route it through the identical refuse-and-stop path
    // above rather than let a raw TypeError surface three calls deeper in upsertMonetGateHook.
    const validated = validateSettingsShape(parsed);
    if (!validated.ok) {
      console.error(
        `monet install: ${target.settingsPath} is valid JSON but not a settings file this command ` +
          `recognizes (${validated.reason}) — refusing to touch it. Fix the file by hand, then re-run.`,
      );
      deps.setExitCode(1);
      return;
    }
    existingSettings = validated.settings;
  }

  // CIRCLE PIN — project scope only (see resolveInstallTarget's own comment for why).
  let pinnedCircle: string | undefined;
  if (target.scope === "project") {
    // FIX 4 (Codex round 2 on PR #42): --dry-run claims "nothing written", but it was reaching
    // ensureMonetDir() (a real mkdir) AND the real deriveCircle() (opens sqlite READ-WRITE,
    // CREATE TABLE IF NOT EXISTS remote_circle_map, and can INSERT a mapping via the Class A/B
    // writeMap path) before ever checking options.dryRun below — a lie by omission. On the
    // dry-run path: skip ensureMonetDir entirely (deriveCircle's own readOnly branch does not
    // need the directory to exist), and resolve the pin via deriveCircle's read-only preview
    // instead — see that function's own {readOnly} contract for exactly what "preview" means
    // (same resolution VALUE as a real install; the only difference is nothing gets persisted).
    if (options.dryRun) {
      pinnedCircle = deps.deriveCircle(target.projectDir, { readOnly: true });
    } else {
      // P1-1 (Codex round 3 on PR #42): ensureMonetDir(target.projectDir) — NOT bare — so the
      // directory created matches where deriveCircle (and circle.ts's own store consultation)
      // actually resolves to. See db/index.ts's own comment for the full CANTOPEN mechanism.
      deps.ensureMonetDir(target.projectDir);
      pinnedCircle = deps.deriveCircle(target.projectDir);
    }

    // FIX 3 (Codex round 2 on PR #42): refuse a wildcard or blank pin BEFORE writing anything —
    // on EITHER path, dry-run or real (a dry-run preview of an install that would immediately be
    // broken is not a useful preview). MONET_CIRCLE='*' set at install time flows straight through
    // deriveCircle's own env-override rung (its first, highest-priority check) and would otherwise
    // get PERMANENTLY baked into the hook command: every later `monet gate` call under that pin
    // hits gate-cli.ts's own QUERY_WILDCARD_CIRCLE refusal (exit 1, a usage error — nothing
    // evaluated), which this wrapper's own round-1 "RECHECK" fix now correctly surfaces as a loud
    // systemMessage — meaning EVERY command carries a "stale install" warning forever, even long
    // after the env var that caused it is gone, until someone thinks to re-run `monet install`
    // with a clean environment. Refusing HERE, before the pin is ever written, is the only fix
    // that does not depend on someone noticing after the fact.
    const trimmedPin = pinnedCircle?.trim();
    if (!trimmedPin) {
      console.error(
        `monet install: deriveCircle resolved an empty circle for ${target.projectDir} — refusing ` +
          `to pin an empty --circle into the hook. This usually means something upstream (git, the ` +
          `store) returned unexpectedly blank; try again, or check MONET_CIRCLE/the store state.`,
      );
      deps.setExitCode(1);
      return;
    }
    if (trimmedPin === QUERY_WILDCARD_CIRCLE) {
      console.error(
        `monet install: deriveCircle resolved the reserved wildcard circle '*' for ` +
          `${target.projectDir} — refusing to pin it into the hook (every later \`monet gate\` call ` +
          `under this pin would exit 1, a usage error, forever, even after the cause is gone). The ` +
          `most likely source is MONET_CIRCLE='*' set in this shell's environment — unset it (or set ` +
          `it to a real circle name) and re-run \`monet install\`.`,
      );
      deps.setExitCode(1);
      return;
    }
  }

  const { execPath, scriptPath } = deps.monetInvocation();
  const wrapperPath = join(deps.homeDir(), ".monet", WRAPPER_FILENAME);
  // NIT (round-5 coordinator review, hooks.md:364/371-377/383-391/504): exec form — `command`
  // resolved as an executable and spawned directly with `args` as the argument vector, "no shell
  // tokenization happens on any platform" (hooks.md:375) — replaces the old shell-form command
  // string built with a hand-rolled shellQuote. This is the doc's own recommended shape for
  // exactly this pattern (hooks.md:380: "the node plus script-path pattern works on every
  // platform because node.exe is a real binary") — execPath/wrapperPath here are that pattern,
  // node plus a resolved script path, even though this call site has no ${...} placeholder to
  // substitute. shellQuote is removed as dead code: this was its only remaining call site, and
  // with no shell involved there is nothing left for it to quote.
  const args = [wrapperPath];
  if (pinnedCircle) args.push("--circle", pinnedCircle);
  const handler: HookHandler = { type: "command", command: execPath, args };

  const nextSettings = upsertMonetGateHook(existingSettings, handler, wrapperPath);
  const wrapperScript = buildWrapperScript({ execPath, scriptPath });

  console.error(`monet install: target ${target.scope === "user" ? "user-global" : "project"} settings at ${target.settingsPath}`);
  if (pinnedCircle) console.error(`monet install: pinned --circle ${pinnedCircle} (resolved live via circle.ts's deriveCircle)`);
  else console.error(`monet install: no --circle pinned (user-global scope — monet gate resolves it per invocation instead)`);

  if (options.dryRun) {
    console.error(`monet install: --dry-run — nothing written`);
    console.log(`--- ${target.settingsPath} (would be written) ---`);
    console.log(JSON.stringify(nextSettings, null, 2));
    console.log(`--- ${wrapperPath} (would be written, mode 0755) ---`);
    console.log(`(${wrapperScript.length} bytes — a generated Node script; see buildWrapperScript in install-cli.ts for its exact source)`);
    console.log(buildCoverageReport());
    return;
  }

  mkdirSync(dirname(target.settingsPath), { recursive: true });
  mkdirSync(dirname(wrapperPath), { recursive: true, mode: 0o700 });
  // FIX 5 (Codex round 2 on PR #42): atomic write-then-rename, not truncate-in-place — see
  // atomicWriteFile's own comment for the full core-mirror-materializer citation.
  atomicWriteFile(wrapperPath, wrapperScript, 0o755);
  atomicWriteFile(target.settingsPath, JSON.stringify(nextSettings, null, 2) + "\n");

  console.error(`monet install: wrote ${wrapperPath}`);
  console.error(`monet install: wrote ${target.settingsPath}`);
  console.log(buildCoverageReport());
}

export function registerInstallCommands(
  program: Command,
  deps: InstallCliDependencies = defaultInstallCliDependencies(),
): Command {
  program
    .command("install")
    .description("Wire a Claude Code PreToolUse hook that enforces declared gate rules via `monet gate`")
    .option("--project <dir>", "Target project directory (default: cwd)")
    .option("--user", "Install into the user-global settings file (~/.claude/settings.json) for every project, instead of this project's own .claude/settings.local.json", false)
    .option("--dry-run", "Print what would be written (the settings file's new content, and the coverage report) without writing anything", false)
    .addHelpText("after", `
Writes (unless --dry-run):
  ~/.monet/gate-hook.mjs                    the generated wrapper (0755; safe to regenerate)
  <target>/.claude/settings.local.json      the PreToolUse hook entry (default; project-scoped)
  ~/.claude/settings.json                   same, with --user (global; no --circle pin — see report)

Idempotent: re-running updates this command's own hook entry in place — it never duplicates it
and never touches any other hook already in the file. Refuses (never overwrites) if the target
settings file exists but is not valid JSON.
`)
    .action((options: InstallCommandOptions) => {
      runInstall(options, deps);
    });
  return program;
}
