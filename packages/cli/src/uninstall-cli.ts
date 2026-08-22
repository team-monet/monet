/**
 * THE MIGRATION PATH OFF A HOOK THAT IS ALREADY ON PEOPLE'S DISKS.
 *
 * `monet install` wired a Claude Code PreToolUse/PostToolUse hook that spawns `monet gate` on every
 * intercepted tool call. Both commands are gone. What is NOT gone is what that install left behind:
 * the generated wrapper at `~/.monet/gate-hook.mjs`, and the settings.json entries pointing at it.
 * Deleting the commands does not reach either one — the entries keep firing, and the wrapper keeps
 * spawning a `monet gate` that no longer exists.
 *
 * WHAT THAT COSTS, PRECISELY, and why it needs a fix rather than a release note. The wrapper treats
 * a failed spawn and an exit-1 usage error identically: `emitSpawnFailureWarning()`, which writes
 * `systemMessage` — the USER's own channel, not the agent's. A `monet` with no `gate` command exits
 * 1 (commander's usage error), so after upgrading, every Bash call and every delegation raises a
 * warning telling the user to "Update monet and re-run `monet install`". That text is baked into
 * each user's own copy of the wrapper and cannot be corrected retroactively: it will keep naming a
 * command this build does not have, forever, on a recurring basis.
 *
 * SO THE FIX HAS TO ACT ON THE WRAPPER'S OWN TERMS, and this module is the two halves of that:
 *
 *   1. `monet gate` survives as a RETIRED SHIM (registerRetiredGateShim). It answers the one thing
 *      the wrapper's exit-code contract reads as "silence, nothing governs this" — exit 0, empty
 *      stdout — which is now literally true. That stops the recurring warning the moment the new
 *      binary is on PATH, with no user action and nothing written anywhere.
 *   2. `monet uninstall` (registerUninstallCommand) is the real removal: it takes the entries out of
 *      the settings files `monet install` could have written, and nothing else.
 *
 * AND ONE NOTICE, ONCE, so (2) is discoverable at all. See `emitRetirementNoticeOnce`.
 */
import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { atomicWriteFile, byteSnapshotStillMatches } from "./atomic-write.js";
import { resolveProjectDir } from "./project-dir.js";

/**
 * The generated wrapper's filename, and the ONLY thing about the old install this module still
 * hardcodes. Its directory is resolved per machine below, because recognition matches the full
 * resolved path rather than this name — see `isMonetGateHandler`.
 */
const WRAPPER_FILENAME = "gate-hook.mjs";

/**
 * The three hook events `monet install` ever wrote. Listed rather than "every event in the file":
 * removal walks exactly the events this project put entries in, so a hook Monet never wrote cannot
 * be reached by this command even through a bug in the recognizer.
 */
const MONET_HOOK_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure"] as const;

interface HookHandler {
  type?: string;
  command?: string;
  args?: string[];
  [key: string]: unknown;
}

interface MatcherGroup {
  matcher?: string;
  hooks?: HookHandler[];
  [key: string]: unknown;
}

interface SettingsFile {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

// ── Recognition ───────────────────────────────────────────────────────────────────────────────

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A BOUNDARY MATCH, NOT A SUBSTRING TEST, and the distinction is carried over verbatim from the
 * install command that wrote these entries: a bare `.includes()` also matches a path that is merely
 * a PREFIX of a longer, different filename, so a user's own `<wrapperPath>.backup` handler would be
 * misclassified as ours and deleted. The path has to appear as a WHOLE shell argument — bounded by
 * start/end of string, whitespace, or a quote character.
 */
function commandReferencesWrapperPathAsArgument(command: string, wrapperPath: string): boolean {
  return new RegExp(`(^|\\s|['"])${escapeForRegExp(wrapperPath)}($|\\s|['"])`).test(command);
}

/**
 * A handler `monet install` wrote, recognized by a FULL RESOLVED WRAPPER PATH — never by the bare
 * filename. This is the guard that stops this command deleting a user's own unrelated hook that
 * happens to reference some other `gate-hook.mjs` elsewhere on their disk, and it is the reason
 * removal can be safe without asking the user to confirm each entry.
 *
 * BOTH HANDLER SHAPES, because both are out there: exec form (`args[0]` is the wrapper path;
 * `command` is an interpreter path that changes across an nvm upgrade and is deliberately NOT part
 * of the match) is what the last version of the install wrote, and shell form (the path quoted
 * inside `command`) is what earlier versions wrote.
 */
function isMonetGateHandler(value: unknown, wrapperPaths: readonly string[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  const handler = value as HookHandler;
  if (handler.type !== "command") return false;
  if (Array.isArray(handler.args)) return wrapperPaths.includes(handler.args[0] ?? "");
  return (
    typeof handler.command === "string" &&
    wrapperPaths.some((wrapperPath) => commandReferencesWrapperPathAsArgument(handler.command as string, wrapperPath))
  );
}

// ── Removal ───────────────────────────────────────────────────────────────────────────────────

/**
 * Strips this project's handlers out of one event's matcher groups, leaving everything else in
 * place and in order.
 *
 * A GROUP IS ONLY OURS TO DROP WHEN WE EMPTIED IT. `originalHooks.length > 0 && survivors.length
 * === 0` — a group the user had already left empty is preserved exactly as given, because this
 * command had nothing of its own to remove from it. The same narrowness the install applied.
 */
function removeFromEvent(
  existing: MatcherGroup[],
  wrapperPaths: readonly string[],
): { groups: MatcherGroup[]; removed: number } {
  const groups: MatcherGroup[] = [];
  let removed = 0;
  for (const group of existing) {
    const originalHooks = group.hooks ?? [];
    const survivors = originalHooks.filter((handler) => !isMonetGateHandler(handler, wrapperPaths));
    removed += originalHooks.length - survivors.length;
    if (survivors.length > 0 || originalHooks.length === 0) {
      groups.push({ ...group, hooks: survivors });
    }
  }
  return { groups, removed };
}

/**
 * The whole-file transform. Returns a NEW object rather than mutating in place, so `--dry-run` can
 * compute exactly what would be written without having changed what it read.
 *
 * AN EVENT EMPTIED BY THIS REMOVAL IS DELETED, and so is a `hooks` object left with nothing in it.
 * Leaving `"PreToolUse": []` behind would be inert but is still a residue of a feature that no
 * longer exists — the point of this command is that the file stops mentioning Monet's hook at all.
 * An event that was ALREADY empty is left exactly as found, for the same reason an already-empty
 * matcher group is.
 */
export function removeMonetHooks(
  settings: SettingsFile,
  wrapperPaths: readonly string[],
): { settings: SettingsFile; removed: number } {
  const next = structuredClone(settings) as SettingsFile;
  const hooks = next.hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    return { settings: next, removed: 0 };
  }
  let removed = 0;
  for (const event of MONET_HOOK_EVENTS) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const result = removeFromEvent(groups as MatcherGroup[], wrapperPaths);
    if (result.removed === 0) continue;
    removed += result.removed;
    if (result.groups.length === 0) delete hooks[event];
    else hooks[event] = result.groups;
  }
  if (removed > 0 && Object.keys(hooks).length === 0) delete next.hooks;
  return { settings: next, removed };
}

/**
 * Refuses a file this command cannot reason about, rather than guessing at it.
 *
 * VALID JSON WITH THE WRONG SHAPE IS THE SAME KIND OF FAILURE AS UNPARSEABLE JSON, from this
 * command's point of view: both mean the safe move is to touch nothing and say which file and why.
 * A settings file is the user's, and a half-understood rewrite of one is worse than an unremoved
 * hook — which the shim has already made harmless.
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
  for (const event of MONET_HOOK_EVENTS) {
    const groups = (settings.hooks as Record<string, unknown>)[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups)) return { ok: false, reason: `\`hooks.${event}\` is present but not an array` };
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index] as unknown;
      if (typeof group !== "object" || group === null || Array.isArray(group)) {
        return { ok: false, reason: `hooks.${event}[${index}] is not an object` };
      }
      const groupHooks = (group as MatcherGroup).hooks;
      if (groupHooks !== undefined && !Array.isArray(groupHooks)) {
        return { ok: false, reason: `hooks.${event}[${index}].hooks is present but not an array` };
      }
    }
  }
  return { ok: true, settings };
}

// ── Paths ─────────────────────────────────────────────────────────────────────────────────────

/**
 * WHERE THE WRAPPER ACTUALLY IS: `~/.monet/gate-hook.mjs`, unconditionally.
 *
 * VERIFIED AGAINST THE INSTALL THAT WROTE IT rather than assumed from the storage-path convention:
 * `runInstall` computed `join(homeDir(), ".monet", WRAPPER_FILENAME)` and never consulted
 * `MONET_STORAGE_DIR` at all. That is the one rung, and it is the path baked into every settings
 * entry on disk. Resolving this on the usual `$MONET_STORAGE_DIR`-first chain would have made
 * `monet uninstall` look for entries naming a path the install never wrote — finding nothing, and
 * reporting "nothing to remove" to precisely the users with a storage override set.
 */
export function installedWrapperPath(): string {
  return path.join(os.homedir(), ".monet", WRAPPER_FILENAME);
}

/**
 * Every path an entry could name, which is not the same question as where the install put the file.
 *
 * `$MONET_STORAGE_DIR` IS INCLUDED AS A SECOND CANDIDATE, not because the install wrote there, but
 * because the generated wrapper resolves its OWN storage directory that way (its line 46), so a
 * user running with an override has a Monet-shaped path in play that the home rung does not cover —
 * a hand-edited entry, or a wrapper copied alongside an overridden store. Matching is on full
 * resolved paths, so an extra candidate widens what this command can clean without widening what it
 * can mistake for ours.
 */
function candidateWrapperPaths(): string[] {
  const paths = [installedWrapperPath()];
  const override = process.env.MONET_STORAGE_DIR;
  if (override) {
    const overridePath = path.join(override, WRAPPER_FILENAME);
    if (!paths.includes(overridePath)) paths.push(overridePath);
  }
  return paths;
}

/**
 * Where the shim's one-time notice marker lives: BESIDE THE INSTALLED WRAPPER, at
 * `~/.monet`, unconditionally — the same rung `installedWrapperPath` resolves, deliberately
 * sharing that function's resolution rather than restating it.
 *
 * IT USED TO SIT ON THE WRAPPER'S OWN SPOOL RUNGS (`$MONET_STORAGE_DIR`, else `~/.monet`), on the
 * reasoning that a file the shim writes at hook time belongs beside whatever store that invocation
 * runs against. That is right for a spool and wrong for THIS file, because the two are keyed to
 * different things (Codex round 4, P2). ESTABLISHED, NOT ASSUMED: `$MONET_STORAGE_DIR` varies per
 * invocation — it is routinely set per project — while the wrapper this notice is about is at
 * `~/.monet/gate-hook.mjs` for every one of those invocations, since `runInstall` computed that
 * path and never consulted the override (see `installedWrapperPath`). A marker on the varying rung
 * therefore promised "shown once" and delivered once per storage directory: a recurring warning
 * with a longer period, which is a quieter version of the exact defect this change exists to
 * remove.
 *
 * THE NOTICE'S OWN SUBJECT SETTLES IT. It says nothing about a store — it says the HOOK is retired
 * and names the command that unwires it — and there is exactly one installed wrapper, and one set
 * of settings files naming it, per home.
 */
function retirementNoticeMarkerDir(): string {
  return path.dirname(installedWrapperPath());
}

/**
 * Every settings file `monet install` could have written, plus the one shareable project file it
 * deliberately never wrote.
 *
 * WHY THE THIRD IS SCANNED ANYWAY: the install chose `.claude/settings.local.json` for project
 * scope on purpose (it is gitignored, and a machine-specific absolute path does not belong in a
 * shared file), but a user who moved the entry by hand into the shareable file would otherwise have
 * no way to remove it with this command. Scanning a file and finding nothing costs nothing, and
 * recognition is keyed on the full wrapper path, so a file this command has no business in cannot
 * lose an entry to it.
 */
function settingsTargets(projectDir: string): Array<{ scope: string; settingsPath: string }> {
  return [
    { scope: "user", settingsPath: path.join(os.homedir(), ".claude", "settings.json") },
    { scope: "project (local)", settingsPath: path.join(projectDir, ".claude", "settings.local.json") },
    { scope: "project (shared)", settingsPath: path.join(projectDir, ".claude", "settings.json") },
  ];
}

// ── The one-time notice ───────────────────────────────────────────────────────────────────────

/**
 * The marker string the ALREADY-INSTALLED wrapper greps its captured stderr for. Baked into every
 * generated wrapper on every disk at install time from the (now-deleted) gate CLI's own exported
 * constant, and it only ever had this one value across the whole life of that command.
 *
 * THIS IS THE ONLY WAY TO REACH THE USER FROM HERE, and it is worth being explicit about why. The
 * wrapper drops the gate's stderr entirely unless a line contains this marker, and every other
 * branch that reaches `systemMessage` also carries a `permissionDecision` that would block a call
 * or interrupt the user for approval. So the shim's choices are: say nothing, or say it through
 * this line. Requirement one forces silence on the recurring path; this makes the ONE exception.
 */
const WRAPPER_FAIL_OPEN_MARKER = "failing OPEN";

/** Where the "already said this" marker lives — see `retirementNoticeMarkerDir` for the rungs. */
function retirementNoticeMarkerPath(): string {
  return path.join(retirementNoticeMarkerDir(), "gate-hook-retired.notice");
}

/**
 * ONE NOTICE, EVER, ON THE USER'S OWN CHANNEL — the answer to "something must tell them the removal
 * command exists".
 *
 * WHY IT CANNOT JUST BE HELP TEXT OR A RELEASE NOTE. Once the shim lands, the stale hook has no
 * symptom: it spawns, answers silence, and the session looks perfectly healthy. Nothing ever
 * prompts the user to go looking, so a passive channel would be read by whoever was already fine.
 * The notice has to arrive unbidden, exactly once.
 *
 * WHY IT CANNOT RECUR. A message on every Bash call is the defect this whole change exists to
 * remove; a quieter version of it would still be it.
 *
 * THE CLAIM IS EXACTLY THE MARKER'S OWN MEANING, not a hijack of it. The wrapper documents this
 * path as "no rule set was consulted, so nothing is known about whether this act is governed" —
 * which is now permanently true, because there is no rule set and no gate. The line says that and
 * then says what to do about it.
 *
 * ATOMIC CLAIM, AND SILENCE ON EVERY FAILURE. `wx` creates only if absent, so two hook invocations
 * racing cannot both win, and an unwritable storage dir, a read-only home, or an already-claimed
 * marker all take the same exit: say nothing. That matters more than it looks — it means the hard
 * requirement (no recurring warning) never depends on this mechanism working. The worst failure
 * here is a notice that is never shown, never a notice shown twice a minute.
 */
function emitRetirementNoticeOnce(): void {
  const markerPath = retirementNoticeMarkerPath();
  try {
    mkdirSync(path.dirname(markerPath), { recursive: true });
    // The claim IS the create. Nothing reads this file's contents; its existence is the whole state.
    closeSync(openSync(markerPath, "wx", 0o600));
  } catch {
    return;
  }
  // ONE LINE. The wrapper filters stderr line by line and joins what matched, so a second line
  // would either be dropped (no marker) or duplicate the marker in the user's message.
  console.error(
    `monet gate: Monet's gate is retired — this hook no longer evaluates anything and is ` +
      `${WRAPPER_FAIL_OPEN_MARKER} (nothing is blocked). Run \`monet uninstall\` to remove it from ` +
      `your Claude Code settings, then restart Claude Code. This notice is shown once.`,
  );
}

// ── The retired shim ──────────────────────────────────────────────────────────────────────────

/**
 * Reads stdin to EOF and throws it away.
 *
 * THIS IS NOT OPTIONAL POLITENESS, it is the difference between the shim working and the shim
 * reproducing the exact bug it exists to fix. The wrapper hands the action context to this process
 * via `spawnSync`'s `input`, and a child that exits without reading it breaks the pipe: measured on
 * this platform, an input over the 64 KiB pipe buffer sets `result.error = EPIPE` on the parent
 * even though the child exited 0. The wrapper checks `result.error` FIRST — before it ever looks at
 * the status — retries via PATH, gets the same EPIPE, and calls `emitSpawnFailureWarning()`. So a
 * shim that ignored stdin would still fire the recurring warning for every command over 64 KiB,
 * which is precisely the large-payload case the wrapper was most carefully built to relay.
 *
 * THE TTY GUARD IS A HANG GUARD. Run by hand in a terminal, stdin is a TTY with no writer and no
 * EOF coming; `readSync` would block until the user pressed ctrl-D. There is also no pipe to break
 * in that case, so skipping is both safe and necessary.
 *
 * EAGAIN IS RETRIED, NOT FATAL: a piped stdin can be non-blocking under load, which is the same
 * condition the wrapper's own read loop handles the same way.
 */
function drainStdin(): void {
  if (process.stdin.isTTY) return;
  const scratch = Buffer.alloc(65536);
  const pauseSignal = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let bytesRead: number;
    try {
      bytesRead = readSync(0, scratch, 0, scratch.length, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        Atomics.wait(pauseSignal, 0, 0, 5);
        continue;
      }
      // EOF on the platforms that signal it as an error, and anything else — a closed or
      // non-readable stdin has nothing to drain and nothing to break.
      return;
    }
    if (bytesRead === 0) return;
  }
}

/**
 * `monet gate`, retired: it drains, it says nothing, it exits 0.
 *
 * EXIT 0 WITH EMPTY STDOUT IS THE WRAPPER'S OWN "NOTHING GOVERNS THIS", stated in its header and
 * quoted from the host's hook docs ("Exit code 0 with no output means the hook has no decision to
 * report, so the tool call continues through the normal permission flow"). It is not a trick to
 * silence a warning — it is the honest answer now that there is no gate: nothing was consulted,
 * nothing is enforced, and the wrapper's `default:` branch turns exactly that into silence.
 *
 * HIDDEN, so `monet --help` does not advertise a command that exists only to be called by
 * already-installed hooks. `allowUnknownOption` and `allowExcessArguments` are load-bearing rather
 * than lax: the settings.json line forwards `--stdin` and whatever `--circle <name>` that install
 * pinned, and commander answers an unrecognized flag with a USAGE ERROR AND EXIT 1 — which the
 * wrapper reads as a broken install and reports as the recurring warning. A shim that refused its
 * own arguments would be a no-op that still shouted.
 */
export function registerRetiredGateShim(program: Command): void {
  program
    .command("gate", { hidden: true })
    .description("Retired. Answers already-installed Monet hooks with silence; run `monet uninstall` to remove them.")
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      drainStdin();
      emitRetirementNoticeOnce();
    });
}

// ── The removal command ───────────────────────────────────────────────────────────────────────

interface UninstallOptions {
  dryRun?: boolean;
}

/**
 * The settings file changed between this command reading it and writing it back.
 *
 * ITS OWN TYPE, so the catch around the write can tell a REFUSAL from a real write failure. A
 * permission error, a full disk, a read-only mount — those must keep propagating to the top-level
 * handler exactly as they did before this check existed; only a concurrent edit is a per-file
 * outcome this command reports and continues past.
 */
class SettingsConflictError extends Error {}

interface UninstallHooks {
  /**
   * Runs immediately before a settings file is written, and exists so a test can open the
   * concurrent-edit window that is otherwise unreachable from outside the process. Same seam, same
   * reason, as `materialize`'s own `beforeSurfaceWrite`: a compare-and-swap whose losing branch
   * cannot be exercised is a safety property nobody can show works.
   */
  beforeSettingsWrite?: (settingsPath: string) => void;
  /**
   * How this command reports "the run left work undone" to whatever invoked it. Defaults to
   * `process.exitCode`, matching `monet materialize` and `monet doctor`/`monet repair`, which take
   * the same value the same way through their own dependency objects — and, like them, NEVER
   * `process.exit()`: the process has to finish writing stderr and unwind normally.
   */
  setExitCode?: (code: number) => void;
}

/**
 * `monet uninstall` — takes the hook entries out, and nothing else.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: delete `~/.monet/gate-hook.mjs`. The wrapper is inert once
 * nothing invokes it, and this command cannot see every settings file that might — an enterprise
 * managed-settings file, or a scope this project never wrote to. Removing the script out from under
 * an entry we did not find would turn a silent no-op into a host-reported hook failure, which is a
 * worse state than a few unused kilobytes. Its path is reported instead.
 *
 * WHY THIS IS A COMMAND RATHER THAN SOMETHING THE SHIM DOES ON ITS OWN: settings.json is the user's
 * file, and the shim runs from a PreToolUse hook — arbitrary cwd, several invocations in flight at
 * once, concurrent with the host's own reads of that file. A rewrite from there is a concurrent
 * write to user configuration on a hot path, undertaken without being asked. Nothing forces that
 * risk, because the shim has already removed the symptom: what is left is cleanup, and cleanup can
 * wait for a deliberate, single, auditable invocation.
 */
export function registerUninstallCommand(program: Command): void {
  program
    .command("uninstall")
    .description("Remove the retired Monet gate hook from your Claude Code settings")
    .option("--dry-run", "Show what would change without writing anything")
    .action((options: UninstallOptions) => {
      runUninstall(options);
    });
}

/**
 * The command's body, extracted so the concurrent-edit refusal below can be exercised — see
 * `UninstallHooks`. The commander action is the only production caller and passes no hooks.
 */
export function runUninstall(options: UninstallOptions, hooks: UninstallHooks = {}): void {
  const wrapperPaths = candidateWrapperPaths();
  const projectDir = resolveProjectDir();
  let removedTotal = 0;
  let refused = 0;
  let conflicted = 0;

  console.error(
    `monet uninstall: removing hook entries that invoke ${wrapperPaths.join(" or ")}`,
  );

  for (const target of settingsTargets(projectDir)) {
    if (!existsSync(target.settingsPath)) continue;

    // READ AS BYTES, PARSED FROM THEM. The bytes are the snapshot the write below compares against,
    // and they have to be the SAME read that produced the parse — re-reading the file to snapshot it
    // would just move the window this check exists to close.
    let snapshot: Buffer;
    let parsed: unknown;
    try {
      snapshot = readFileSync(target.settingsPath);
      parsed = JSON.parse(snapshot.toString("utf8"));
    } catch (error) {
      refused++;
      console.error(
        `monet uninstall: ${target.settingsPath} is not valid JSON ` +
          `(${error instanceof Error ? error.message : String(error)}) — left untouched`,
      );
      continue;
    }

    const shape = validateSettingsShape(parsed);
    if (!shape.ok) {
      refused++;
      console.error(
        `monet uninstall: ${target.settingsPath} is not a settings file this command can read ` +
          `safely (${shape.reason}) — left untouched`,
      );
      continue;
    }

    const result = removeMonetHooks(shape.settings, wrapperPaths);
    if (result.removed === 0) continue;

    if (options.dryRun) {
      removedTotal += result.removed;
      console.error(
        `monet uninstall: would remove ${result.removed} hook ` +
          `${result.removed === 1 ? "entry" : "entries"} from ${target.scope} settings at ${target.settingsPath}`,
      );
      continue;
    }

    // REFUSE, DO NOT CLOBBER. Everything between the read above and the rename inside
    // `atomicWriteFile` is a window in which Claude Code, a settings UI, or another config command
    // can write this same file — and this command's write is a WHOLE-FILE replacement built from
    // what it read, so anything landing in that window is silently erased. That loss is
    // unrecoverable in a way none of this module's other failure modes are: settings.json is the
    // user's own configuration, and nothing Monet holds could reconstruct an edit it overwrote.
    //
    // The check is the same best-effort byte compare-and-swap `monet materialize` already uses on
    // the user's standing files, running immediately before the rename — see
    // `byteSnapshotStillMatches` for exactly what it does and does not catch.
    //
    // AN UNREMOVED HOOK ENTRY IS THE CHEAP OUTCOME HERE, which is what makes refusing the right
    // default rather than merely the cautious one: the retired shim (above) has already made a
    // stale entry harmless, so the worst case of refusing is a rerun, while the worst case of
    // writing is a destroyed edit.
    try {
      hooks.beforeSettingsWrite?.(target.settingsPath);
      atomicWriteFile(
        target.settingsPath,
        JSON.stringify(result.settings, null, 2) + "\n",
        undefined,
        () => {
          if (!byteSnapshotStillMatches(target.settingsPath, snapshot)) {
            throw new SettingsConflictError(target.settingsPath);
          }
        },
      );
    } catch (error) {
      // ONLY THE CONFLICT IS SWALLOWED. Every other write failure keeps propagating exactly as it
      // did before, to the top-level handler.
      if (!(error instanceof SettingsConflictError)) throw error;
      conflicted++;
      console.error(
        `monet uninstall: ${target.settingsPath} changed after it was read — refusing to overwrite ` +
          `a concurrent edit; nothing was removed from it. Rerun \`monet uninstall\`.`,
      );
      continue;
    }
    removedTotal += result.removed;
    console.error(
      `monet uninstall: removed ${result.removed} hook ` +
        `${result.removed === 1 ? "entry" : "entries"} from ${target.scope} settings at ${target.settingsPath}`,
    );
  }

  // A TARGET THIS RUN LEFT UNFINISHED — refused before it could be read, or refused at the write to
  // protect a concurrent edit. THE TWO REASONS ARE INTERCHANGEABLE TO EVERY CLAIM BELOW, because
  // each sentence down here generalizes over "the files above" and neither state can be spoken for:
  // a conflicted file is KNOWN to still hold entries, and an unreadable one is simply UNKNOWN.
  // Withholding on only one of them was the bug — an unknown reported as a verdict.
  const unfinished = refused + conflicted;

  // AND SAID IN THE ONE CHANNEL AUTOMATION CAN READ (Codex round 4, P2). Everything below is
  // careful to withhold any claim this run did not establish — the "nothing to remove" verdict, the
  // "unreferenced" advice — and then the process exited 0 regardless, which is itself a claim, and
  // the only one a script ever sees. Exit 0 from a removal command reads as "the entries are gone";
  // a caller chaining on `&&` could not tell a refusal from a completed run, and the PARTIAL case
  // is the sharpest: other files really were rewritten, so every other signal looks like success
  // while a hook entry is still wired somewhere this run could not speak for.
  //
  // ONE, not a code per reason. This package already has a convention for exactly this state and it
  // is a single value: `monet materialize` sets 1 for a per-surface failure inside a run that
  // otherwise completed, and `monet materialize list` does the same per surface. (`monet doctor`'s
  // 2 is a different meaning entirely — a diagnostic verdict on a healthy store, not undone work.)
  // Refused-unreadable and refused-on-conflict are interchangeable here for the same reason every
  // sentence below treats them as one: both leave a target this run cannot speak for.
  //
  // NOT AN EXCEPTION, and not `process.exit()`: the loop above already did real work on the other
  // targets, and its report of that work is what the user needs. Setting the code and returning
  // normally is what keeps both.
  if (unfinished > 0) (hooks.setExitCode ?? ((code: number) => { process.exitCode = code; }))(1);

  if (removedTotal === 0) {
    // SAID PLAINLY, because "nothing happened" is the answer for everyone who never ran the old
    // install, and it must not read like a failure. NOT SAID AT ALL when a target was left
    // unfinished: that run did not establish there is nothing to remove, and the line below says
    // what it actually knows instead.
    if (unfinished === 0) {
      console.error(`monet uninstall: no Monet hook entries found — nothing to remove.`);
    }
    if (refused > 0) {
      console.error(
        `monet uninstall: ${refused} settings ${refused === 1 ? "file" : "files"} could not be read safely ` +
          `(above) — if the hook was wired there, remove its entry by hand.`,
      );
    }
    return;
  }

  // THE FOOTER DESCRIBES THE RUN THAT ACTUALLY HAPPENED. Under `--dry-run` the loop above wrote
  // nothing, so every past-tense claim here was false on that path: there is no change to restart
  // for, and the wrapper is referenced by exactly the entries that are still on disk. This line is
  // reached only with entries actually removed, so it holds regardless of `unfinished`: a target
  // left behind does not make the change to the others need less of a restart.
  console.error(
    options.dryRun
      ? `monet uninstall: nothing was written — rerun without --dry-run to apply, then restart Claude Code.`
      : `monet uninstall: restart Claude Code for the change to take effect.`,
  );
  // AND THE WRAPPER CLAIM IS NOT MADE AT ALL WHEN A TARGET WAS LEFT UNFINISHED: that file can still
  // hold an entry naming the wrapper, so "unreferenced by the files above" would be wrong in the one
  // case it matters. A user who deletes the wrapper on that advice converts an inert hook into a
  // host-visible missing-file failure on every tool call — strictly worse than what they had.
  if (unfinished > 0) return;
  for (const wrapperPath of wrapperPaths.filter((candidate) => existsSync(candidate))) {
    // NAMED, NOT DELETED — see `registerUninstallCommand`'s own comment for why.
    console.error(
      options.dryRun
        ? `monet uninstall: the generated wrapper at ${wrapperPath} would then be unreferenced by ` +
            `the files above and safe to delete by hand.`
        : `monet uninstall: the generated wrapper at ${wrapperPath} is now unreferenced by the ` +
            `files above and is safe to delete by hand.`,
    );
  }
}

/** Both halves of the retirement, registered together so neither can ship without the other. */
export function registerHookRetirementCommands(program: Command): void {
  registerUninstallCommand(program);
  registerRetiredGateShim(program);
}
