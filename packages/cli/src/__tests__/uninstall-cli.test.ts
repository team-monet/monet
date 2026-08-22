/**
 * THE MIGRATION PATH OFF A HOOK THAT IS ALREADY ON PEOPLE'S DISKS.
 *
 * A previous release's `monet install` wrote hook entries into Claude Code's settings and a wrapper
 * script into `~/.monet`, and this build removed the `monet gate` those entries invoke. Neither the
 * entries nor the wrapper are reachable by deleting a command, so both halves of the recovery are
 * asserted here:
 *
 *   - the RETIRED SHIM answers an already-installed hook with the silence the wrapper's own
 *     exit-code contract reads as "nothing governs this", and says what to run — exactly once;
 *   - `monet uninstall` takes the entries out, and takes NOTHING that is not ours.
 *
 * THE SECOND HALF IS THE ONE WITH TEETH. This command edits the user's settings file, so most of
 * what follows is about what it must LEAVE BEHIND: a foreign hook in a group it also touched, a
 * foreign hook whose path merely resembles ours, and a group the user had already left empty.
 */
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeMonetHooks, runUninstall } from "../uninstall-cli";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  home: string;
  storageDir: string;
  projectDir: string;
  /** Where `monet install` actually put the wrapper: `~/.monet`, unconditionally. */
  wrapperPath: string;
  /** The `$MONET_STORAGE_DIR` variant — never written by the install, but reachable by hand. */
  overrideWrapperPath: string;
  userSettings: string;
  projectSettings: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "monet-uninstall-"));
  dirs.push(root);
  const home = join(root, "home");
  const storageDir = join(root, "store");
  const projectDir = join(root, "project");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(storageDir, { recursive: true });
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  return {
    home,
    storageDir,
    projectDir,
    wrapperPath: join(home, ".monet", "gate-hook.mjs"),
    overrideWrapperPath: join(storageDir, "gate-hook.mjs"),
    userSettings: join(home, ".claude", "settings.json"),
    projectSettings: join(projectDir, ".claude", "settings.local.json"),
  };
}

function runCli(f: Fixture, args: string[]): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: f.home,
      MONET_STORAGE_DIR: f.storageDir,
      CLAUDE_PROJECT_DIR: f.projectDir,
    },
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

/**
 * The same command, driven IN PROCESS so a test can reach `beforeSettingsWrite`.
 *
 * The subprocess harness above is the right default — it proves the wiring all the way through
 * commander — but the concurrent-edit window this command now refuses to write into opens and
 * closes inside a single function call, and nothing outside that process can land an edit in it
 * reliably. `runUninstall`'s hook is the seam; this is the only thing that uses it.
 */
function runInProcess(
  f: Fixture,
  options: { dryRun?: boolean },
  hooks: Parameters<typeof runUninstall>[1] = {},
): { stderr: string } {
  const saved = {
    HOME: process.env.HOME,
    MONET_STORAGE_DIR: process.env.MONET_STORAGE_DIR,
    MONET_PROJECT_DIR: process.env.MONET_PROJECT_DIR,
    CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
  };
  process.env.HOME = f.home;
  process.env.MONET_STORAGE_DIR = f.storageDir;
  delete process.env.MONET_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = f.projectDir;
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    runUninstall(options, hooks);
  } finally {
    spy.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { stderr: lines.join("\n") };
}

describe("removeMonetHooks — what it takes, and what it must not", () => {
  const wrapperPath = "/home/u/.monet/gate-hook.mjs";
  const monetExecForm = { type: "command", command: "/usr/bin/node", args: [wrapperPath, "--circle", "acme"] };
  const monetShellForm = { type: "command", command: `'/usr/bin/node' '${wrapperPath}' --circle acme` };

  it("removes both handler shapes a previous install could have written", () => {
    const settings = {
      hooks: {
        PreToolUse: [{ matcher: "^Bash$", hooks: [monetExecForm] }],
        PostToolUse: [{ matcher: "^Bash$", hooks: [monetShellForm] }],
      },
    };
    const result = removeMonetHooks(settings, [wrapperPath]);
    // EXEC FORM is what the last install wrote; SHELL FORM is what earlier ones wrote, and a user
    // who upgraded across that change has one of each. Recognizing only one leaves half the hook.
    expect(result.removed).toBe(2);
    expect(result.settings.hooks).toBeUndefined();
  });

  it("leaves a foreign handler sharing a group with ours, in place and in order", () => {
    const linter = { type: "command", command: "/usr/local/bin/my-own-linter" };
    const settings = { hooks: { PreToolUse: [{ matcher: "^Bash$", hooks: [monetExecForm, linter] }] } };

    const result = removeMonetHooks(settings, [wrapperPath]);
    expect(result.removed).toBe(1);
    // The group SURVIVES because something the user owns is still in it — dropping it would delete
    // their hook to tidy away ours.
    expect(result.settings.hooks).toEqual({ PreToolUse: [{ matcher: "^Bash$", hooks: [linter] }] });
  });

  it("does not touch a foreign hook whose path merely resembles the wrapper's", () => {
    // THE TWO NEAR-MISSES THIS COMMAND MUST SURVIVE, both real shapes a user can have on disk:
    // a hand-made backup of the old wrapper (our path is a strict PREFIX of theirs), and an
    // unrelated script that happens to share the filename in another directory.
    const backup = { type: "command", command: `node '${wrapperPath}.backup' --circle acme` };
    const sameName = { type: "command", command: "node /Users/someone/scripts/gate-hook.mjs" };
    const settings = { hooks: { PreToolUse: [{ matcher: "^Edit$", hooks: [backup, sameName] }] } };

    const result = removeMonetHooks(settings, [wrapperPath]);
    expect(result.removed).toBe(0);
    expect(result.settings).toEqual(settings);
  });

  it("keeps a group the user had already left empty, and drops only one it emptied itself", () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: "^Write$", hooks: [] },
          { matcher: "^Bash$", hooks: [monetExecForm] },
        ],
      },
    };
    const result = removeMonetHooks(settings, [wrapperPath]);
    // `^Bash$` held only ours, so it goes. `^Write$` was empty before this command ran and has
    // nothing to do with Monet — deleting it would be this command editing something it never wrote.
    expect(result.settings.hooks).toEqual({ PreToolUse: [{ matcher: "^Write$", hooks: [] }] });
  });

  it("never reaches an event this project did not write", () => {
    const foreign = { type: "command", command: "/usr/bin/node", args: [wrapperPath] };
    const settings = { hooks: { SessionStart: [{ hooks: [foreign] }] } };
    // Even a handler that WOULD be recognized is out of reach under an event `monet install` never
    // wrote to. Removal walks a named list of events, so a bug in the recognizer still cannot
    // wander into the user's other hooks.
    expect(removeMonetHooks(settings, [wrapperPath])).toEqual({ settings, removed: 0 });
  });

  it("does not mutate the object it was given", () => {
    const settings = { hooks: { PreToolUse: [{ matcher: "^Bash$", hooks: [monetExecForm] }] } };
    const snapshot = structuredClone(settings);
    removeMonetHooks(settings, [wrapperPath]);
    // `--dry-run` computes the result purely to print it, and must not have silently changed what
    // it read on the way.
    expect(settings).toEqual(snapshot);
  });
});

describe("monet uninstall", () => {
  function writeInstalledFixture(f: Fixture): void {
    writeFileSync(
      f.userSettings,
      JSON.stringify({
        model: "opus",
        hooks: {
          PreToolUse: [
            {
              matcher: "^Bash$",
              hooks: [
                { type: "command", command: "/usr/bin/node", args: [f.wrapperPath, "--circle", "acme"] },
                { type: "command", command: "/usr/local/bin/my-own-linter" },
              ],
            },
            {
              matcher: "^(Task|Agent)$",
              hooks: [{ type: "command", command: "/usr/bin/node", args: [f.wrapperPath, "--circle", "acme"] }],
            },
          ],
          PostToolUse: [
            {
              matcher: "^Bash$",
              hooks: [
                { type: "command", command: "/usr/bin/node", args: [f.wrapperPath, "--circle", "acme", "--post-tool-use"] },
              ],
            },
          ],
          SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
        },
      }),
    );
    // An OLDER, shell-form install in the project-scoped file the install actually targeted.
    writeFileSync(
      f.projectSettings,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "^Bash$", hooks: [{ type: "command", command: `'/usr/bin/node' '${f.wrapperPath}' --circle proj` }] },
          ],
        },
      }),
    );
  }

  it("removes the entries from both scopes and leaves everything else standing", () => {
    const f = fixture();
    writeInstalledFixture(f);

    const result = runCli(f, ["uninstall"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("removed 3 hook entries");
    expect(result.stderr).toContain("removed 1 hook entry");
    // The user has to be told, or the entries are gone and the running session still has them.
    expect(result.stderr).toContain("restart Claude Code");

    const user = readJson(f.userSettings);
    expect(user.model).toBe("opus");
    const hooks = user.hooks as Record<string, unknown>;
    // The delegation group held only ours, so it goes; the Bash group keeps the user's linter.
    expect(hooks.PreToolUse).toEqual([
      { matcher: "^Bash$", hooks: [{ type: "command", command: "/usr/local/bin/my-own-linter" }] },
    ]);
    // PostToolUse held nothing but ours — the event itself goes rather than being left as `[]`.
    expect(hooks.PostToolUse).toBeUndefined();
    // An event Monet never wrote to is carried over verbatim.
    expect(hooks.SessionStart).toEqual([{ hooks: [{ type: "command", command: "echo hi" }] }]);

    expect(readJson(f.projectSettings).hooks).toBeUndefined();
  });

  it("--dry-run reports the same removal and writes nothing", () => {
    const f = fixture();
    writeInstalledFixture(f);
    const before = readFileSync(f.userSettings, "utf8");

    const result = runCli(f, ["uninstall", "--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("would remove 3 hook entries");
    expect(readFileSync(f.userSettings, "utf8")).toBe(before);
  });

  it("--dry-run's footer claims nothing the run did not do", () => {
    const f = fixture();
    writeInstalledFixture(f);
    // The wrapper has to be ON DISK for the footer to reach its claim about it at all.
    mkdirSync(join(f.home, ".monet"), { recursive: true });
    writeFileSync(f.wrapperPath, "// the generated wrapper");

    const result = runCli(f, ["uninstall", "--dry-run"]);
    expect(result.status).toBe(0);
    // THE BUG THIS PINS: the loop skipped every write and the footer still spoke in the past tense —
    // a wrapper reported as "now unreferenced" while every entry naming it is still on disk, and a
    // restart demanded for a change that does not exist. A user who deleted the wrapper on that
    // advice would be left with live hook entries pointing at a missing file.
    expect(result.stderr).not.toContain("is now unreferenced");
    expect(result.stderr).not.toContain("restart Claude Code for the change to take effect");
    // What it says instead is conditional, and says plainly that nothing was written.
    expect(result.stderr).toContain("nothing was written");
    expect(result.stderr).toContain("would then be unreferenced");
    // And the entries really are all still there, which is what makes the past tense false.
    expect(readJson(f.userSettings).hooks).toBeDefined();
  });

  it("refuses to overwrite a settings file that changed after it was read", () => {
    const f = fixture();
    writeInstalledFixture(f);
    mkdirSync(join(f.home, ".monet"), { recursive: true });
    writeFileSync(f.wrapperPath, "// the generated wrapper");
    // WHAT LANDS IN THE WINDOW: a whole-file rewrite of the kind Claude Code, a settings UI, or
    // another config command performs — and nothing this removal would ever produce, so its
    // survival cannot be an accident of the two writes agreeing.
    const concurrent = `${JSON.stringify({ model: "sonnet", statusLine: "mine" }, null, 2)}\n`;
    let injected = false;

    const result = runInProcess(f, {}, {
      beforeSettingsWrite: (settingsPath) => {
        if (settingsPath !== f.userSettings || injected) return;
        injected = true;
        writeFileSync(f.userSettings, concurrent);
      },
    });

    expect(injected).toBe(true);
    // THE PROOF, and the reason this is worth a check at all: settings.json is the USER's file, so a
    // write lost here is not recoverable from anything Monet holds.
    expect(readFileSync(f.userSettings, "utf8")).toBe(concurrent);
    expect(result.stderr).toContain("changed after it was read");
    expect(result.stderr).toContain("refusing to overwrite a concurrent edit");
    // NOT COUNTED AS REMOVED — the entries are still in whatever the other writer left behind.
    expect(result.stderr).not.toContain("removed 3 hook");
    // AND THE WRAPPER CLAIM IS WITHHELD: a file that still names it was refused, so "unreferenced"
    // is exactly the sentence this run cannot honestly say.
    expect(result.stderr).not.toContain("unreferenced");
    // The scope that was NOT interfered with is still cleaned — one refusal is not an abort.
    expect(readJson(f.projectSettings).hooks).toBeUndefined();
  });

  it("says nothing about 'nothing to remove' when the only file with entries was refused", () => {
    const f = fixture();
    // ONE target only, so a refusal leaves removedTotal at zero and the footer has to choose.
    writeFileSync(
      f.userSettings,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "^Bash$", hooks: [{ type: "command", command: "/usr/bin/node", args: [f.wrapperPath] }] },
          ],
        },
      }),
    );
    const result = runInProcess(f, {}, {
      beforeSettingsWrite: () => writeFileSync(f.userSettings, "{}\n"),
    });
    // Entries WERE found. Reporting "nothing to remove" would be the one reading of this run that is
    // simply false, and it is the reading a user acts on by deleting the wrapper.
    expect(result.stderr).not.toContain("nothing to remove");
    expect(result.stderr).toContain("changed after it was read");
  });

  it("is idempotent, and says plainly when there is nothing to remove", () => {
    const f = fixture();
    writeInstalledFixture(f);
    expect(runCli(f, ["uninstall"]).status).toBe(0);

    const second = runCli(f, ["uninstall"]);
    expect(second.status).toBe(0);
    // The same answer everyone who never ran the old install gets. It must not read as a failure.
    expect(second.stderr).toContain("no Monet hook entries found");
    expect(second.stderr).not.toContain("removed");
  });

  it("finds the entry at the path the install actually wrote, not at a storage override", () => {
    const f = fixture();
    // THE BUG THIS PINS: `monet install` computed the wrapper path as `~/.monet/gate-hook.mjs` and
    // never consulted MONET_STORAGE_DIR, so that home path is what is baked into every settings
    // entry on disk. Resolving it on the usual override-first chain would make this command look
    // for a path the install never wrote — reporting "nothing to remove" to exactly the users who
    // have a storage override set. This fixture HAS one, and it points somewhere else.
    writeFileSync(
      f.userSettings,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "^Bash$", hooks: [{ type: "command", command: "/usr/bin/node", args: [f.wrapperPath] }] },
          ],
        },
      }),
    );
    expect(f.wrapperPath).not.toBe(f.overrideWrapperPath);

    const result = runCli(f, ["uninstall"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("removed 1 hook entry");
    expect(readJson(f.userSettings).hooks).toBeUndefined();
  });

  it("also removes an entry naming the storage-override path", () => {
    const f = fixture();
    // Not a shape the install produced, but a Monet-shaped path a user running with an override can
    // plausibly have hand-wired — and one the home rung alone would never reach.
    writeFileSync(
      f.userSettings,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "^Bash$", hooks: [{ type: "command", command: "/usr/bin/node", args: [f.overrideWrapperPath] }] },
          ],
        },
      }),
    );

    const result = runCli(f, ["uninstall"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("removed 1 hook entry");
    expect(readJson(f.userSettings).hooks).toBeUndefined();
  });

  it("refuses a settings file it cannot read safely, and says so instead of rewriting it", () => {
    const f = fixture();
    writeFileSync(f.userSettings, "{ this is not json");

    const result = runCli(f, ["uninstall"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("is not valid JSON");
    expect(result.stderr).toContain("left untouched");
    // A half-understood rewrite of the user's settings is worse than an unremoved hook — which the
    // shim has already made harmless. So the bytes are still exactly as found...
    expect(readFileSync(f.userSettings, "utf8")).toBe("{ this is not json");
    // ...and the user is told a file was skipped, so "nothing to remove" cannot be mistaken for
    // "nothing was there".
    expect(result.stderr).toContain("remove its entry by hand");
  });
});

describe("the retired `monet gate` shim", () => {
  /**
   * The wrapper spawns `monet gate --stdin` and writes the action context to its stdin. Both
   * details matter and both are reproduced here rather than described.
   */
  function runShim(f: Fixture, input: string, extraArgs: string[] = []): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "gate", "--stdin", ...extraArgs], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      input,
      env: { ...process.env, HOME: f.home, MONET_STORAGE_DIR: f.storageDir },
    });
  }

  it("exits 0 with empty stdout — the wrapper's own 'nothing governs this'", () => {
    const f = fixture();
    const result = runShim(f, "Bash:ls -la");
    // EXIT 0 AND EMPTY STDOUT is the whole contract. The wrapper's `default:` branch turns exactly
    // that into silence; any other status is a decision it would act on, and exit 1 in particular
    // is what it reports to the USER as a broken install on every single tool call.
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("accepts the arguments an old settings.json line forwards", () => {
    const f = fixture();
    // A pinned `--circle` rides on the settings entry's own command line and reaches the gate
    // verbatim. Commander answers an unrecognized option with a usage error and EXIT 1 — the very
    // status the wrapper reports as a broken install — so a shim that refused its own arguments
    // would be a no-op that still shouted.
    const result = runShim(f, "Bash:ls", ["--circle", "acme-widgets"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("drains an input larger than the pipe buffer instead of breaking the pipe", () => {
    const f = fixture();
    // MEASURED, NOT ASSUMED: a child that exits without reading sets `error = EPIPE` on the
    // PARENT's spawnSync once the input passes the 64 KiB pipe buffer — and the wrapper checks
    // `error` before it ever looks at the status, so it would fall through to its spawn-failure
    // warning on every large command. 300 KiB is comfortably past that boundary.
    const result = runShim(f, `Bash:echo ${"x".repeat(300_000)}`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("names the removal command on the user's channel exactly once, then never again", () => {
    const f = fixture();

    const first = runShim(f, "Bash:ls");
    // THE ONE CHANNEL THAT REACHES THE USER. The wrapper drops the gate's stderr entirely unless a
    // line carries this marker, and every other branch that reaches `systemMessage` also carries a
    // permissionDecision that would block the call or interrupt for approval.
    expect(first.stderr).toContain("failing OPEN");
    // Without this the fix is silent in both directions: the warning stops, and nothing ever tells
    // the user the hook is still wired or how to remove it.
    expect(first.stderr).toContain("monet uninstall");
    // ONE LINE — the wrapper filters stderr line by line and joins what matched.
    expect(first.stderr.trim().split("\n")).toHaveLength(1);

    // AND NOW THE POINT. A quieter version of a message on every Bash call is still a message on
    // every Bash call.
    for (let i = 0; i < 3; i++) {
      const later = runShim(f, "Bash:ls");
      expect(later.status).toBe(0);
      expect(later.stdout).toBe("");
      expect(later.stderr).toBe("");
    }
  });

  it("stays silent when the notice marker cannot be claimed, rather than repeating", () => {
    const f = fixture();
    // The claim is an atomic create, so an existing marker — whether from an earlier run or a
    // concurrent hook invocation that won the race — takes the same exit as an unwritable store:
    // say nothing. That is what keeps the hard requirement (no recurring warning) independent of
    // whether this notice mechanism works at all.
    writeFileSync(join(f.storageDir, "gate-hook-retired.notice"), "");
    const result = runShim(f, "Bash:ls");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("is hidden from help, while `uninstall` is not", () => {
    const f = fixture();
    const help = runCli(f, ["--help"]);
    // `gate` exists only to be called by hooks that are already installed; advertising it would
    // present a retired mechanism as a feature. The command the user actually needs is listed.
    expect(help.stdout).toContain("uninstall");
    // MATCHED AS A COMMAND ENTRY, not as a substring: the word "gate" legitimately appears inside
    // `uninstall`'s own description ("the retired Monet gate hook"), so a bare `.toContain` check
    // would fail on correct output and prove nothing about the command list.
    expect(help.stdout).not.toMatch(/^\s+gate\b/m);
  });
});
