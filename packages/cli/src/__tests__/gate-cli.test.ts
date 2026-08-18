import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MonetCore, deriveCircle as coreDeriveCircle } from "@team-monet/core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GATE_EXIT_CODE,
  GateActionContextError,
  RETAINED_STDIN_CAP_BYTES,
  classifyGateResult,
  ensureToolPrefixedContext,
  formatMirrorAge,
  readGateMirrorFile,
  readStdinSync,
  describeResolvedCircle,
  resolveActionContextSource,
  resolveGateCircle,
  resolveRuntimeModelTag,
  runGate,
} from "../gate-cli";
import { canonicalRemoteKey, defaultNameFromRemote, getOriginRemote } from "../remote-circle";
import type { GateMirror, GateResult } from "@team-monet/core";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CLI_ENTRY = join(REPO_ROOT, "src/cli.ts");
// Node's `--import <bare-specifier>` resolves the specifier relative to the CHILD PROCESS's own
// cwd when launched via child_process (confirmed empirically — this differs from a directly
// shell-launched `node --import tsx ...`, which is not cwd-sensitive the same way). Any test that
// spawns with a cwd outside this repo (spawnGateAt, below) would otherwise fail with
// ERR_MODULE_NOT_FOUND for "tsx" itself, before the CLI under test ever runs. An ABSOLUTE path to
// tsx's own loader module sidesteps bare-specifier resolution entirely. `node_modules/tsx` is
// pnpm's real top-level symlink for this direct devDependency (stable across tsx versions,
// verified: `ls -la node_modules/tsx` → `-> .pnpm/tsx@.../node_modules/tsx`), and `"."` is tsx's
// own documented export map entry for `./dist/loader.mjs` (see node_modules/tsx/package.json).
const TSX_LOADER = join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs");

/** Declaration-1-shaped fixture: a global blocking deny, a circle-scoped advisory, and a rule-less stage. */
async function buildFixtureMirror(mirrorPath: string): Promise<void> {
  const core = new MonetCore(":memory:", { gateSidecarPath: mirrorPath, defaultCircle: "acme-widgets" });
  await core.declare({
    species: "rule", stage: "git force push", patterns: ["Bash:git push --force"],
    content: "Never force-push to main.", severity: "blocking", scope: "domain",
    reason: "a rewritten history cannot be recovered from a teammate's clone",
    circle: "*",
  });
  await core.declare({
    species: "rule", stage: "terraform apply", patterns: ["Bash:terraform apply"],
    content: "Always run plan first.", severity: "advisory", scope: "domain",
    circle: "acme-widgets",
  });
  await core.declare({ species: "stage", stage: "empty stage", patterns: ["Bash:frobnicate --hard"] });
  core.materializeGateMirror();
  core.close();
}

interface FixtureRuleSpec {
  stage: string;
  /** Omit when a PRIOR rule spec in the same call already established this stage's patterns —
   *  re-passing `patterns` for a stage that already carries a live blocking rule trips core's own
   *  pattern-reauthoring guard (assertPatternReauthoringAcknowledged), even when the patterns are
   *  identical. Only the FIRST rule bound to a given stage name should set this. */
  pattern?: string;
  content: string;
  severity: "blocking" | "advisory";
  scope?: "domain" | "agent";
  modelTag?: string;
  reason?: string;
  circle?: string;
}

/** A more flexible fixture builder for scenarios buildFixtureMirror doesn't cover (mixed severities
 *  on one stage, agent-scoped rules with a model tag, distinctive per-project markers). */
async function buildCustomFixtureMirror(
  mirrorPath: string,
  rules: FixtureRuleSpec[],
  defaultCircle = "acme-widgets",
): Promise<void> {
  const core = new MonetCore(":memory:", { gateSidecarPath: mirrorPath, defaultCircle });
  for (const rule of rules) {
    await core.declare({
      species: "rule",
      stage: rule.stage,
      ...(rule.pattern ? { patterns: [rule.pattern] } : {}),
      content: rule.content,
      severity: rule.severity,
      scope: rule.scope ?? "domain",
      ...(rule.modelTag ? { modelTag: rule.modelTag } : {}),
      ...(rule.reason ? { reason: rule.reason } : {}),
      ...(rule.circle ? { circle: rule.circle } : {}),
    });
  }
  core.materializeGateMirror();
  core.close();
}

let gateStorageDir: string;

beforeAll(() => {
  gateStorageDir = mkdtempSync(join(tmpdir(), "monet-gate-cli-storage-"));
});

afterAll(() => rmSync(gateStorageDir, { recursive: true, force: true }));

/** Preserve the developer's normal process environment without leaking unrelated Monet overrides
 *  into a child whose Monet inputs are owned by the test. */
function isolatedGateEnv(
  ownedMonetEnv: NodeJS.ProcessEnv = {},
  inheritedEnv: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("MONET_")),
  ),
): NodeJS.ProcessEnv {
  return { ...inheritedEnv, ...ownedMonetEnv, MONET_STORAGE_DIR: gateStorageDir };
}

// A spawned gate writes its journal even for silence; helper-owned isolation prevents fixtures
// reaching the developer's live ~/.monet journal, including when a caller supplies another env.
function spawnGate(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(
    process.execPath,
    ["--import", TSX_LOADER, "src/cli.ts", "gate", ...args],
    { cwd: REPO_ROOT, encoding: "utf8", env: isolatedGateEnv({}, env) },
  );
}

/** Like spawnGate, but spawns with an arbitrary cwd — needed to probe cwd-vs-project-dir bugs.
 *  Uses an ABSOLUTE path to cli.ts since `cwd` is not REPO_ROOT here. */
function spawnGateAt(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  storage: "isolate" | "home-fallback" = "isolate",
) {
  return spawnSync(
    process.execPath,
    ["--import", TSX_LOADER, CLI_ENTRY, "gate", ...args],
    { cwd, encoding: "utf8", env: storage === "isolate" ? isolatedGateEnv({}, env) : env },
  );
}

/** Like spawnGate, but pipes `stdinContent` in via spawnSync's own `input` option — component A's
 *  --stdin transport, exercised through the REAL spawned CLI process (a real pipe, real EAGAIN
 *  risk on this platform — see readStdinSync's own comment in gate-cli.ts). */
function spawnGateStdin(stdinContent: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(
    process.execPath,
    ["--import", TSX_LOADER, "src/cli.ts", "gate", "--stdin", ...args],
    { cwd: REPO_ROOT, encoding: "utf8", env: isolatedGateEnv({}, env), input: stdinContent },
  );
}

/** Build a throwaway git repo with the given origin URL (config read only, no network) — the
 *  P1 fix (Codex round 2 on PR #40) needs a REAL repo with a REAL origin to reproduce the bug
 *  (getOriginRemote shells `git remote get-url origin`, which needs a real .git directory).
 *  Mirrors circle.test.ts's own `makeRepo` helper exactly. */
function makeRepoWithRemote(url: string, dir: string): void {
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  g(["init", "--quiet"]);
  g(["config", "user.email", "test@example.com"]);
  g(["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "# test\n");
  g(["add", "."]);
  g(["commit", "--quiet", "-m", "init"]);
  g(["remote", "add", "origin", url]);
}

describe("monet gate CLI", () => {
  const dirs: string[] = [];
  const mkTmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "monet-gate-cli-"));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // ── --help documents the five outcomes + usage error, per the command's own contract ─────────

  it("documents exit codes in --help through the real CLI process", () => {
    const result = spawnGate(["--help"]);
    expect(result.status).toBe(0);
    // [action-context] is OPTIONAL now (4b-D, component A: --stdin can supply it instead).
    expect(result.stdout).toContain("Usage: monet gate [options] [action-context]");
    expect(result.stdout).toContain("0   silence");
    expect(result.stdout).toContain("10  stage-hit-no-rules");
    expect(result.stdout).toContain("20  advisory-inject");
    expect(result.stdout).toContain("30  blocking-deny");
    expect(result.stdout).toContain("40  overflow-ask");
    expect(result.stdout).toContain("1   usage error");
  });

  // ── Five outcomes, five exit codes, through the real CLI process ─────────────────────────────

  it("outcome 0 — silence: no stage matches, empty stdout", () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    return buildFixtureMirror(mirrorPath).then(() => {
      const result = spawnGate(["Bash:ls -la", "--circle", "acme-widgets", "--mirror", mirrorPath]);
      expect(result.status).toBe(GATE_EXIT_CODE.SILENCE);
      expect(result.stdout).toBe("");
    });
  });

  it("outcome 0 — silence: --force-with-lease is a DIFFERENT token than --force, not a substring match", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const result = spawnGate(["Bash:git push --force-with-lease", "--circle", "acme-widgets", "--mirror", mirrorPath]);
    expect(result.status).toBe(GATE_EXIT_CODE.SILENCE);
    expect(result.stdout).toBe("");
  });

  it("outcome 10 — stage-hit-no-rules: a rule-less stage matches", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const result = spawnGate(["Bash:frobnicate --hard", "--circle", "acme-widgets", "--mirror", mirrorPath]);
    expect(result.status).toBe(GATE_EXIT_CODE.STAGE_HIT_NO_RULES);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("stage 'empty stage' matched with no live rules bound");
  });

  it("outcome 10 — stage-hit-no-rules: stage matches but its rule is scoped to a different circle", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    // "terraform apply"'s advisory rule lives in circle "acme-widgets" only (no breadth) — querying
    // a different circle still matches the (store-global) stage but delivers no rule for it.
    const result = spawnGate(["Bash:terraform apply", "--circle", "someone-elses-project", "--mirror", mirrorPath]);
    expect(result.status).toBe(GATE_EXIT_CODE.STAGE_HIT_NO_RULES);
    expect(result.stdout).toBe("");
  });

  /**
   * WHAT THE ADVISORY PAYLOAD IS NOW (#49): identity plus an instruction, emitted ONCE — never the
   * rule's own text, and never one line per rule. This test previously pinned that older contract
   * with an exact-equality assertion on the rule's text, so it is rewritten rather than patched:
   * the promise it made is deliberately gone, not merely reworded.
   */
  it("outcome 20 — advisory-inject: ONE identity instruction on stdout, naming the matched stage, carrying no rule text", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const result = spawnGate(["Bash:terraform apply", "--circle", "acme-widgets", "--mirror", mirrorPath]);
    expect(result.status).toBe(GATE_EXIT_CODE.ADVISORY_INJECT);
    expect(result.stdout).toBe(
      "1 Monet rule governs this action, at `terraform apply`.\n" +
        "Call stage_lookup on each before acting; this hook carries identity only, not rule text.\n",
    );
    // The fixture's advisory reads "Always run plan first" — the payload must not carry it.
    expect(result.stdout).not.toContain("Always run plan first");
  });

  /**
   * A DENY IS NOT A CONTENT EXCEPTION (#49). This test previously pinned "the reason verbatim on
   * stdout" — the deny path was the one place rule content was quoted, on the theory that a refusal
   * must explain itself. It no longer is: the call is refused either way, the blocking COUNT is
   * disclosed so a reader knows what to look for, and whoever wants the reason opens the rule via
   * `stage_lookup`. The mirror-age disclosure on stderr is untouched by #49 and still asserted here
   * unchanged — an offline deny is a cached deny, and that promise did not move.
   */
  it("outcome 30 — blocking-deny: an identity instruction disclosing the blocking count on stdout, mirror age disclosed on stderr", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const result = spawnGate(["Bash:git push --force", "--circle", "acme-widgets", "--mirror", mirrorPath]);
    expect(result.status).toBe(GATE_EXIT_CODE.BLOCKING_DENY);
    expect(result.stdout).toBe(
      "Blocked by a Monet rule — 1 rule (1 blocking) at `git force push`.\n" +
        "Call stage_lookup on each before acting; this hook carries identity only, not rule text.\n",
    );
    expect(result.stdout).not.toContain("Never force-push to main");
    expect(result.stdout).not.toContain("a rewritten history cannot be recovered");
    expect(result.stderr).toMatch(/generated .*ago/);
    expect(result.stderr).toContain("an offline answer is a cached answer");
  });

  it("outcome 30 — breadth ('*') deny fires regardless of the queried circle", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const result = spawnGate(["Bash:git push --force", "--circle", "a-totally-different-circle", "--mirror", mirrorPath]);
    expect(result.status).toBe(GATE_EXIT_CODE.BLOCKING_DENY);
  });

  /**
   * THE INVARIANT #49 INTRODUCES, asserted directly rather than left as a side effect of the two
   * outcome tests above: NO rule body text and NO reason reaches the payload, on EITHER firing
   * path. The fixture plants markers that could only come from rule content, so a leak of either
   * field — a future formatter change, a debug line, a re-added "helpful" excerpt — fails here and
   * names which field leaked.
   */
  it("#49 invariant: neither firing path puts rule body text or a reason on the payload", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildCustomFixtureMirror(mirrorPath, [
      {
        stage: "deploy prod", pattern: "Bash:deploy prod",
        content: "BODY-MARKER-BLOCKING never ship on a Friday.", severity: "blocking",
        reason: "REASON-MARKER-BLOCKING nobody is around to roll it back",
      },
      {
        stage: "run migrations", pattern: "Bash:run migrations",
        content: "BODY-MARKER-ADVISORY take a snapshot first.", severity: "advisory",
        reason: "REASON-MARKER-ADVISORY a bad migration is not reversible",
      },
    ]);

    const deny = spawnGate(["Bash:deploy prod", "--circle", "acme-widgets", "--mirror", mirrorPath]);
    expect(deny.status).toBe(GATE_EXIT_CODE.BLOCKING_DENY);
    expect(deny.stdout).not.toContain("BODY-MARKER-BLOCKING");
    expect(deny.stdout).not.toContain("REASON-MARKER-BLOCKING");

    const advisory = spawnGate(["Bash:run migrations", "--circle", "acme-widgets", "--mirror", mirrorPath]);
    expect(advisory.status).toBe(GATE_EXIT_CODE.ADVISORY_INJECT);
    expect(advisory.stdout).not.toContain("BODY-MARKER-ADVISORY");
    expect(advisory.stdout).not.toContain("REASON-MARKER-ADVISORY");

    // NOT VACUOUS: a real instruction was emitted on each path and each names its own stage, so the
    // markers are absent from a payload that exists rather than from an empty stream.
    expect(deny.stdout).toContain("at `deploy prod`.");
    expect(advisory.stdout).toContain("at `run migrations`.");
  });

  it("outcome 40 — overflow-ask is wired through classifyGateResult (see below for why not spawned)", () => {
    // NOT exercised end-to-end via spawnSync: the engine's overflow threshold (MAX_CONTEXT_BYTES,
    // 4 MiB — @team-monet/core/gates.ts) exceeds this OS's ARG_MAX for a single argv element
    // (`getconf ARG_MAX` = 1,048,576 bytes here; confirmed empirically — spawnSync raises E2BIG
    // before this CLI's own code ever runs). `monet gate <action-context>` takes the context as a
    // positional argv arg, so overflow is genuinely unreachable through a real spawned process on
    // this machine — a real finding, not a test-writing shortcut (see this slice's report). Covered
    // instead by the in-process tests below: `classifyGateResult` on overflow, and the real
    // `evaluateGateFromMirror` against an over-threshold context further down.
    const overflowResult: GateResult = { stage: null, stages: [], rules: [], silence: false, overflow: true, source: "sidecar" };
    expect(classifyGateResult(overflowResult)).toEqual({ code: GATE_EXIT_CODE.OVERFLOW_ASK, label: "overflow-ask" });
  });

  it("outcome 40 — the real evaluator (not a stub) reports overflow for an over-threshold context", async () => {
    const { evaluateGateFromMirror } = await import("@team-monet/core");
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const mirror = JSON.parse(readFileSync(mirrorPath, "utf8")) as GateMirror;
    const over = "x".repeat(4 * 1024 * 1024 + 1);
    const result = evaluateGateFromMirror(mirror, { actionContext: `Bash:${over}`, circle: "acme-widgets" });
    expect(result.overflow).toBe(true);
    expect(classifyGateResult(result).code).toBe(GATE_EXIT_CODE.OVERFLOW_ASK);
  });

  // ── The Tool: prefix is load-bearing (item 4) ─────────────────────────────────────────────────

  it("refuses an unprefixed action context — never silently unmatched", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const result = spawnGate(["git push --force", "--circle", "acme-widgets", "--mirror", mirrorPath]);
    expect(result.status).toBe(1);
    expect(result.status).not.toBe(GATE_EXIT_CODE.SILENCE);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("has no 'Tool:' prefix");
  });

  it("--tool synthesizes the prefix as a convenience and still matches", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const result = spawnGate(["git push --force", "--tool", "Bash", "--circle", "acme-widgets", "--mirror", mirrorPath]);
    expect(result.status).toBe(GATE_EXIT_CODE.BLOCKING_DENY);
    // The exit code above is what this test protects. The payload no longer quotes the rule (#49),
    // so what it corroborates now is WHICH stage the synthesized prefix reached.
    expect(result.stdout).toContain("(1 blocking) at `git force push`");
  });

  it("an invalid --tool value cannot synthesize a prefix and is refused", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const result = spawnGate(["git push --force", "--tool", "not a tool name", "--circle", "acme-widgets", "--mirror", mirrorPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not be synthesized");
  });

  // ── Failure policy: missing / malformed mirror both fail OPEN, loudly, exit 0 ────────────────

  it("missing mirror fails open loudly at exit 0", () => {
    const dir = mkTmp();
    const result = spawnGate(["Bash:git push --force", "--mirror", join(dir, "does-not-exist.json")]);
    expect(result.status).toBe(GATE_EXIT_CODE.SILENCE);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("failing OPEN");
    expect(result.stderr).toContain("no readable mirror");
  });

  it("a corrupted mirror (one flipped byte inside a string value) fails open loudly at exit 0", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const raw = readFileSync(mirrorPath, "utf8");
    const idx = raw.indexOf("Never force-push to main");
    expect(idx).toBeGreaterThan(-1);
    // Flip one printable character INSIDE a string value — JSON stays syntactically valid (so a
    // plain JSON.parse would not catch it), and no array-shape check catches it either. Only the
    // checksum does — this is the exact case @team-monet/core's checksum field was added to catch.
    const corrupted = `${raw.slice(0, idx)}X${raw.slice(idx + 1)}`;
    expect(corrupted).not.toBe(raw);
    const corruptPath = join(dir, "corrupt-mirror.json");
    writeFileSync(corruptPath, corrupted);

    const result = spawnGate(["Bash:git push --force", "--circle", "acme-widgets", "--mirror", corruptPath]);
    expect(result.status).toBe(GATE_EXIT_CODE.SILENCE);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("failing OPEN");
    expect(result.stderr).toContain("checksum mismatch");
  });

  // ── Circle resolution without the store ───────────────────────────────────────────────────────

  it("circle chain: explicit --circle beats MONET_CIRCLE env", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const result = spawnGate(
      ["Bash:terraform apply", "--circle", "acme-widgets", "--mirror", mirrorPath],
      { ...process.env, MONET_CIRCLE: "some-other-circle-entirely" },
    );
    expect(result.stderr).toContain("circle acme-widgets (resolved from flag)");
    expect(result.status).toBe(GATE_EXIT_CODE.ADVISORY_INJECT);
  });

  it("circle chain: MONET_CIRCLE env is used when --circle is absent", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const result = spawnGate(
      ["Bash:terraform apply", "--mirror", mirrorPath],
      { ...process.env, MONET_CIRCLE: "acme-widgets" },
    );
    expect(result.stderr).toContain("circle acme-widgets (resolved from env)");
    expect(result.status).toBe(GATE_EXIT_CODE.ADVISORY_INJECT);
  });

  it("circle chain: falls back to folder derivation when neither --circle nor MONET_CIRCLE is set (and there is no remote)", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    // A plain, never-git-init'd project dir (P1 fix, Codex round 2 on PR #40 — this test used to
    // spawn from REPO_ROOT itself, but this repo genuinely HAS an origin remote, so after the fix
    // it correctly resolves via the remote-aware pick instead of the folder fallback this test
    // means to demonstrate. A project dir with NO git repo at all is the clean, deterministic way
    // to exercise the true "no remote" case, independent of this repo's own ambient git config.)
    const projectDir = mkTmp();
    const { MONET_CIRCLE: _unused, ...envWithoutCircle } = process.env;
    const env = { ...envWithoutCircle, MONET_PROJECT_DIR: projectDir };
    const result = spawnGateAt(projectDir, ["Bash:frobnicate --hard", "--mirror", mirrorPath], env);
    // Confirms SOME folder-derived value is reported, not the fixture's own circle.
    expect(result.stderr).toMatch(/circle .+ \(resolved from folder\)/);
  });

  it("circle chain: the mirror's own circleAliases resolves an unaliased folder-hash slug (Class A backward compat), end to end", async () => {
    // A throwaway project dir with no git repo of its own — deriveCircle then hashes the path
    // directly (no `git rev-parse --show-toplevel` to redirect it), so the slug is a pure,
    // predictable function of this one directory, exactly like circle.ts's own Class A case: an
    // EXISTING install already has memory under the raw folder-hash slug, and gets renamed to a
    // friendly circle name (the migration a real upgrade would run) — `renameCircle` refuses a
    // slug with no footprint at all ("circle not found"), so the rule is declared directly under
    // `folderSlug` first, exactly reproducing that precondition rather than faking the alias row.
    const projectDir = mkTmp();
    const folderSlug = coreDeriveCircle(projectDir);

    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    const core = new MonetCore(":memory:", { gateSidecarPath: mirrorPath, defaultCircle: "acme-widgets" });
    await core.declare({
      species: "rule", stage: "terraform apply", patterns: ["Bash:terraform apply"],
      content: "Always run plan first.", severity: "advisory", scope: "domain",
      circle: folderSlug,
    });
    core.renameCircle(folderSlug, "acme-widgets");
    core.materializeGateMirror();
    core.close();

    const mirror = JSON.parse(readFileSync(mirrorPath, "utf8")) as GateMirror;
    expect(mirror.circleAliases).toEqual(expect.arrayContaining([{ from: folderSlug, to: "acme-widgets" }]));

    const { MONET_CIRCLE: _unused, ...envWithoutCircle } = process.env;
    const env = { ...envWithoutCircle, MONET_PROJECT_DIR: projectDir };
    const result = spawnGate(["Bash:terraform apply", "--mirror", mirrorPath], env);
    expect(result.stderr).toContain(`circle acme-widgets (mirror alias of ${folderSlug}, resolved from folder)`);
    expect(result.status).toBe(GATE_EXIT_CODE.ADVISORY_INJECT);
  });

  it("circle chain: ONE alias hop total — a chained alias map gives folder-derived and explicit inputs the same answer (Codex r1 i3)", async () => {
    // The evaluator applies a single alias hop to whatever circle it receives (parity with the live
    // resolver). The old CLI ALSO advanced the folder-derived slug one hop before evaluation, so a
    // chained map folderSlug→B, B→C evaluated a folder-derived query as C (no rules there) while an
    // explicit `--circle <folderSlug>` evaluated as B — same circle named two ways, two different
    // answers. Chains cannot be minted locally (renameCircle flattens), so the B→C row is injected
    // into the mirror file directly with the checksum stripped — the documented pre-checksum shape
    // core's own reader tolerates.
    const projectDir = mkTmp();
    const folderSlug = coreDeriveCircle(projectDir);

    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    const core = new MonetCore(":memory:", { gateSidecarPath: mirrorPath, defaultCircle: "acme-widgets" });
    await core.declare({
      species: "rule", stage: "terraform apply", patterns: ["Bash:terraform apply"],
      content: "Always run plan first.", severity: "advisory", scope: "domain",
      circle: folderSlug,
    });
    core.renameCircle(folderSlug, "acme-widgets");
    core.materializeGateMirror();
    core.close();

    const mirror = JSON.parse(readFileSync(mirrorPath, "utf8")) as GateMirror & { checksum?: string };
    mirror.circleAliases.push({ from: "acme-widgets", to: "somewhere-else-entirely" });
    delete mirror.checksum;
    writeFileSync(mirrorPath, JSON.stringify(mirror, null, 2));

    const { MONET_CIRCLE: _unused, ...envWithoutCircle } = process.env;
    const env = { ...envWithoutCircle, MONET_PROJECT_DIR: projectDir };
    const viaFolder = spawnGate(["Bash:terraform apply", "--mirror", mirrorPath], env);
    const viaFlag = spawnGate(["Bash:terraform apply", "--circle", folderSlug, "--mirror", mirrorPath]);
    // One hop lands on acme-widgets (where the rule lives) for BOTH inputs; the old double hop sent
    // the folder-derived query on to somewhere-else-entirely and answered stage-hit-no-rules.
    expect(viaFolder.status).toBe(GATE_EXIT_CODE.ADVISORY_INJECT);
    expect(viaFlag.status).toBe(GATE_EXIT_CODE.ADVISORY_INJECT);
    expect(viaFolder.stdout).toBe(viaFlag.stdout);
    expect(viaFolder.stderr).toContain(`circle acme-widgets (mirror alias of ${folderSlug}, resolved from folder)`);
  });

  // ── '*' is refused BEFORE the mirror is read (Codex r1 i1), same wording as core's own
  //    assertQueryableCircle ────────────────────────────────────────────────────────────────────

  it("--circle '*' is refused at exit 1", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const result = spawnGate(["Bash:terraform apply", "--circle", "*", "--mirror", mirrorPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not a queryable circle");
    expect(result.stderr).toContain("reserved global-breadth marker");
  });

  it("--circle '*' with a MISSING mirror is still exit 1, never masked by the fail-open path", () => {
    // The old order read the mirror first, so a missing/malformed mirror answered exit 0 before
    // the wildcard was ever rejected — a permanently invalid hook configuration reading as clean.
    const dir = mkTmp();
    const result = spawnGate(["Bash:terraform apply", "--circle", "*", "--mirror", join(dir, "absent.json")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not a queryable circle");
    expect(result.stderr).not.toContain("failing OPEN");
  });

  // ── Live-fixture-shaped smoke, but via a temp copy (the real live file is exercised separately
  //    for the manual smoke report — this pins the same scenario as an automated regression) ────

  it("end-to-end: declaration-1-shaped deny fires, force-with-lease does not, advisory injects", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);

    const deny = spawnGate(["Bash:git push --force", "--circle", "acme-widgets", "--mirror", mirrorPath]);
    expect(deny.status).toBe(30);

    const lease = spawnGate(["Bash:git push --force-with-lease", "--circle", "acme-widgets", "--mirror", mirrorPath]);
    expect(lease.status).toBe(0);

    const advisory = spawnGate(["Bash:terraform apply", "--circle", "acme-widgets", "--mirror", mirrorPath]);
    expect(advisory.status).toBe(20);
  });

  // ── Coordinator review round: BLOCKER 1 ───────────────────────────────────────────────────────

  it("BLOCKER 1: the default mirror path must follow the SAME project dir as circle resolution (MONET_PROJECT_DIR), not cwd", async () => {
    // Two distinct "projects", each with its own .monet/gate-mirror.json carrying a rule that
    // matches nothing in the OTHER project's mirror. MONET_PROJECT_DIR names A; cwd is B. No
    // --mirror flag — this exercises the DEFAULT path resolution specifically. If the default
    // mirror path is derived from cwd (the bug) rather than resolveProjectDir() (what circle
    // resolution already correctly uses), this reads B's mirror: A's pattern matches nothing
    // there, so the CLI reports silence — a deny that should have fired, lost without a trace
    // (byte-identical stderr to genuine silence, per the reviewer's own probe).
    const projectA = mkTmp();
    const projectB = mkTmp();
    mkdirSync(join(projectA, ".monet"), { recursive: true });
    mkdirSync(join(projectB, ".monet"), { recursive: true });

    await buildCustomFixtureMirror(join(projectA, ".monet", "gate-mirror.json"), [{
      stage: "deploy a", pattern: "Bash:deploy-a-only", content: "Never deploy A without review.",
      severity: "blocking", reason: "reason-from-project-A-only", circle: "*",
    }]);
    await buildCustomFixtureMirror(join(projectB, ".monet", "gate-mirror.json"), [{
      stage: "deploy b", pattern: "Bash:deploy-b-only", content: "Never deploy B without review.",
      severity: "blocking", reason: "reason-from-project-B-only", circle: "*",
    }]);

    // Strip anything in the inherited env that could otherwise redirect resolution out from under
    // the test (MONET_STORAGE_DIR bypasses baseDir entirely; MONET_CIRCLE is irrelevant here since
    // both rules are breadth-scoped, stripped anyway for a clean probe).
    const { MONET_STORAGE_DIR: _s, MONET_CIRCLE: _c, ...cleanEnv } = process.env;
    const env = { ...cleanEnv, MONET_PROJECT_DIR: projectA, HOME: gateStorageDir };

    const result = spawnGateAt(projectB, ["Bash:deploy-a-only"], env, "home-fallback");
    expect(result.status).toBe(GATE_EXIT_CODE.BLOCKING_DENY);
    // WHICH mirror answered is still the whole point of this test; only the marker moved. The
    // payload carries identity rather than the reason (#49), so the STAGE NAME — unique per
    // project in this fixture — is what separates A's mirror from B's.
    expect(result.stdout).toContain("`deploy a`");
    expect(result.stdout).not.toContain("`deploy b`");
  });

  // ── Coordinator review round: SHOULD-FIX 2 (element-shape validation, unconditional) ─────────

  it("SHOULD-FIX 2a: a checksum-stripped file with a corrupted severity value must fail open, not deliver a deny as advisory", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const parsed = JSON.parse(readFileSync(mirrorPath, "utf8")) as Record<string, unknown>;
    delete parsed.checksum;
    const entries = parsed.entries as Array<Record<string, unknown>>;
    const denyEntry = entries.find((e) => e.severity === "blocking");
    expect(denyEntry).toBeDefined();
    denyEntry!.severity = "Blocking"; // not a member of RULE_SEVERITIES — a shape violation, not a byte flip
    const corruptPath = join(dir, "corrupted-severity.json");
    writeFileSync(corruptPath, JSON.stringify(parsed, null, 2));

    const result = spawnGate(["Bash:git push --force", "--circle", "acme-widgets", "--mirror", corruptPath]);
    expect(result.status).toBe(GATE_EXIT_CODE.SILENCE);
    expect(result.status).not.toBe(GATE_EXIT_CODE.ADVISORY_INJECT);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("failing OPEN");
  });

  it("SHOULD-FIX 2b: a checksum-stripped file with `scope` deleted on an agent rule must fail open, not deny for the wrong model", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildCustomFixtureMirror(mirrorPath, [{
      stage: "rm -rf", pattern: "Bash:rm -rf", content: "Old model deletes without confirming.",
      severity: "blocking", scope: "agent", modelTag: "model-OLD",
      reason: "this model deletes without asking first",
    }]);
    const parsed = JSON.parse(readFileSync(mirrorPath, "utf8")) as Record<string, unknown>;
    delete parsed.checksum;
    const entries = parsed.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    delete entries[0]!.scope;
    const corruptPath = join(dir, "corrupted-scope.json");
    writeFileSync(corruptPath, JSON.stringify(parsed, null, 2));

    // MONET_MODEL_TAG names a DIFFERENT model than the rule's own modelTag ("model-OLD") — with a
    // legitimate `scope: "agent"` this rule would be filtered out (stage-hit-no-rules). With
    // `scope` deleted, core's own `ruleTagIsLive` reads `scope !== "agent"` as true for `undefined`
    // and treats the rule as always-live — a deny fires for a model it was never declared for.
    const result = spawnGate(
      ["Bash:rm -rf", "--circle", "acme-widgets", "--mirror", corruptPath],
      { ...process.env, MONET_MODEL_TAG: "model-NEW" },
    );
    expect(result.status).toBe(GATE_EXIT_CODE.SILENCE);
    expect(result.status).not.toBe(GATE_EXIT_CODE.BLOCKING_DENY);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("failing OPEN");
  });

  // ── Coordinator review round: SHOULD-FIX 3 (excess positional arguments) ─────────────────────

  it("SHOULD-FIX 3: excess positional arguments are refused, never silently truncated to the first token", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    // A real caller forgetting to quote `monet gate "Bash:terraform apply"` produces exactly this
    // argv shape: two positional tokens. Commander's default silently binds only the first to
    // <action-context> and drops "apply" — "Bash:terraform" alone matches no rule (silence),
    // the same silent-fail-open class ensureToolPrefixedContext already refuses for a missing
    // Tool: prefix.
    const result = spawnGate(["Bash:terraform", "apply", "--circle", "acme-widgets", "--mirror", mirrorPath]);
    expect(result.status).toBe(1);
    expect(result.status).not.toBe(GATE_EXIT_CODE.SILENCE);
  });

  // ── #49: a mixed fire is ONE instruction naming every matched stage (replaces SHOULD-FIX 4) ──

  /**
   * WHAT THIS REPLACES, AND WHY THE OLD SHAPE EXISTED. Before #49 the payload carried rule TEXT,
   * one line per rule, with no severity marker anywhere in the line protocol. Putting a blocking
   * rule and an advisory on the same stdout would therefore have left a reader guessing which line
   * was the enforceable one — so the deny path emitted blocking lines on stdout and disclosed any
   * co-firing advisory separately on stderr ("advisory also fired (not part of the deny)"). That
   * split was the only way to keep the two severities distinguishable while quoting content.
   *
   * Identity payloads dissolve the ambiguity instead of routing around it: nothing on the wire
   * reads as guidance, so nothing can be mistaken for the enforceable line. ONE instruction now
   * names every matched stage — including a stage that contributed only advisories — and states
   * how many of the matched rules block. A separate stderr disclosure would repeat what stdout
   * already carries, so it is gone.
   *
   * The fixture deliberately spans TWO stages: "npm publish" (blocking + advisory) and "release
   * hygiene" (advisory only). An advisory-only stage is precisely what the old split banished to
   * stderr, so its appearing in the stdout instruction IS the behavior change under test.
   */
  it("#49: a mixed blocking+advisory fire is ONE instruction naming every matched stage, with the blocking count", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildCustomFixtureMirror(mirrorPath, [
      {
        stage: "npm publish", pattern: "Bash:npm publish", content: "Never publish without 2FA.",
        severity: "blocking", reason: "a stolen token can publish a malicious version",
      },
      {
        stage: "npm publish", content: "Bump the changelog first.",
        severity: "advisory",
      },
      {
        stage: "release hygiene", pattern: "Bash:npm", content: "Tag the release commit.",
        severity: "advisory", reason: "an untagged release cannot be bisected",
      },
    ]);
    const result = spawnGate(["Bash:npm publish", "--circle", "acme-widgets", "--mirror", mirrorPath]);
    expect(result.status).toBe(GATE_EXIT_CODE.BLOCKING_DENY);
    // ONE instruction — two lines, both stages named, the blocking count disclosed.
    expect(result.stdout).toBe(
      "Blocked by a Monet rule — 3 rules (1 blocking) at `npm publish`, `release hygiene`.\n" +
        "Call stage_lookup on each before acting; this hook carries identity only, not rule text.\n",
    );
    // Neither severity gets its content quoted — that symmetry is what removes the ambiguity the
    // old stdout/stderr split existed to manage.
    for (const content of [
      "Never publish without 2FA",
      "a stolen token can publish a malicious version",
      "Bump the changelog",
      "Tag the release commit",
      "an untagged release cannot be bisected",
    ]) {
      expect(result.stdout).not.toContain(content);
    }
    // The stderr side-channel is gone: the advisory is disclosed by being named in the stdout
    // instruction's own stage list, not relegated to a channel the agent never reads.
    expect(result.stderr).not.toContain("advisory also fired");
  });

  // ── Coordinator review round: deny path also names the repair command (SHOULD-FIX 5) ─────────

  it("SHOULD-FIX 5: the deny path names the same regeneration advice the missing/malformed path names", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const result = spawnGate(["Bash:git push --force", "--circle", "acme-widgets", "--mirror", mirrorPath]);
    expect(result.status).toBe(GATE_EXIT_CODE.BLOCKING_DENY);
    expect(result.stderr).toContain("generated");
    // Updated wording (4b-D, component D): now that `monet start` actually keeps the mirror
    // fresh (component B), the honest repair line names THAT rather than a manual core API call.
    expect(result.stderr).toContain("monet start");
    expect(result.stderr).toContain("monet install");
  });

  // ── Coordinator review round: additional coverage gap — MONET_MODEL_TAG plumbing, end to end ─

  it("MONET_MODEL_TAG plumbing: an agent-scoped rule for a different model is filtered out (stage-hit-no-rules, not a deny)", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildCustomFixtureMirror(mirrorPath, [{
      stage: "rm -rf", pattern: "Bash:rm -rf", content: "Old model deletes without confirming.",
      severity: "blocking", scope: "agent", modelTag: "model-OLD",
      reason: "this model deletes without asking first",
    }]);
    const result = spawnGate(
      ["Bash:rm -rf", "--circle", "acme-widgets", "--mirror", mirrorPath],
      { ...process.env, MONET_MODEL_TAG: "model-NEW" },
    );
    expect(result.status).toBe(GATE_EXIT_CODE.STAGE_HIT_NO_RULES);
    expect(result.status).not.toBe(GATE_EXIT_CODE.BLOCKING_DENY);
    expect(result.stdout).toBe("");
  });

  // ── P1 fix (Codex round 2 on PR #40): remote-aware circle resolution ─────────────────────────
  //
  // Codex's verbatim scenario: "When a Git project has an `origin` and neither --circle nor
  // MONET_CIRCLE is supplied, this always selects core's folder-hash slug, while the live client
  // selects the remote mapping or, for a new unmapped repository, the deterministic remote-derived
  // name... Consequently, a mirror containing a circle-scoped blocking rule created by the live
  // session has no matching rule for the gate's folder circle, so the hook returns
  // stage-hit-no-rules instead of denying." Fails-before-fix evidence for test 1 is in this
  // slice's report (reconstructed from commit c403381 via `git show`, run standalone — the
  // ACTUAL fix already lives in this working tree, so the historical file was read via git
  // history rather than by reverting anything here).

  it("P1 REGRESSION test 1: a genuinely new repo with an origin resolves to defaultNameFromRemote, not the folder-hash slug", async () => {
    const repoDir = mkTmp();
    const remoteUrl = "git@github.com:acme/widgets.git";
    makeRepoWithRemote(remoteUrl, repoDir);

    // Compute the expected circle via the imported function — never hardcoded — and confirm this
    // is genuinely the P1's "new repo" case: the expected circle is NOT the folder-hash slug.
    const expectedCircle = defaultNameFromRemote(remoteUrl);
    const folderSlug = coreDeriveCircle(repoDir);
    expect(expectedCircle).not.toBe(folderSlug);

    mkdirSync(join(repoDir, ".monet"), { recursive: true });
    const mirrorPath = join(repoDir, ".monet", "gate-mirror.json");
    await buildCustomFixtureMirror(mirrorPath, [{
      stage: "npm publish", pattern: "Bash:npm publish", content: "Never publish without 2FA.",
      severity: "blocking", circle: expectedCircle,
      reason: "a stolen token can publish a malicious version",
    }]);

    // No --circle, no MONET_CIRCLE, no --mirror (exercising the DEFAULT mirror-path resolution
    // too) — MONET_PROJECT_DIR is the only thing naming which project this is, exactly the shape
    // a spawned hook process has.
    const { MONET_STORAGE_DIR: _storage, ...envWithoutStorageDir } = isolatedGateEnv({
      MONET_PROJECT_DIR: repoDir,
      HOME: gateStorageDir,
    });
    expect(Object.keys(envWithoutStorageDir).filter((name) => name.startsWith("MONET_"))).toEqual(["MONET_PROJECT_DIR"]);
    expect(envWithoutStorageDir.MONET_STORAGE_DIR).toBeUndefined();
    const result = spawnGateAt(repoDir, ["Bash:npm publish"], envWithoutStorageDir, "home-fallback");
    expect(result.status).toBe(GATE_EXIT_CODE.BLOCKING_DENY);
    // Circle resolution is the subject: that the deny FIRED proves the circle-scoped rule was
    // found. The payload names the stage rather than quoting the rule (#49).
    expect(result.stdout).toContain("(1 blocking) at `npm publish`");
    expect(result.stderr).toContain(`circle ${expectedCircle} (resolved from remote)`);
  });

  it("Class A + remote: an aliased folder slug still wins and delivers (the alias, not defaultNameFromRemote)", async () => {
    // The folder-hash slug already has a friendly-name alias (circle.ts's Class A — the common
    // case for an EXISTING install with a remote) — the remote-aware pick must not override that
    // with defaultNameFromRemote; folderSlug is in mirror.circles (every alias from/to name is),
    // so folderSlug wins, and the EVALUATOR's own one-hop alias resolution delivers the rule.
    const repoDir = mkTmp();
    makeRepoWithRemote("git@github.com:acme/widgets.git", repoDir);
    const folderSlug = coreDeriveCircle(repoDir);
    const friendlyName = "acme-widgets-friendly";

    mkdirSync(join(repoDir, ".monet"), { recursive: true });
    const mirrorPath = join(repoDir, ".monet", "gate-mirror.json");
    const core = new MonetCore(":memory:", { gateSidecarPath: mirrorPath, defaultCircle: friendlyName });
    await core.declare({
      species: "rule", stage: "npm publish", patterns: ["Bash:npm publish"],
      content: "Never publish without 2FA.", severity: "blocking", scope: "domain",
      reason: "a stolen token can publish a malicious version", circle: folderSlug,
    });
    core.renameCircle(folderSlug, friendlyName);
    core.materializeGateMirror();
    core.close();

    const mirror = JSON.parse(readFileSync(mirrorPath, "utf8")) as GateMirror;
    expect(mirror.circles).toEqual(expect.arrayContaining([folderSlug, friendlyName]));

    const { MONET_STORAGE_DIR: _storage, ...envWithoutStorageDir } = isolatedGateEnv({
      MONET_PROJECT_DIR: repoDir,
      HOME: gateStorageDir,
    });
    const result = spawnGateAt(repoDir, ["Bash:npm publish"], envWithoutStorageDir, "home-fallback");
    expect(result.status).toBe(GATE_EXIT_CODE.BLOCKING_DENY);
    // Circle resolution is the subject: that the deny FIRED proves the circle-scoped rule was
    // found. The payload names the stage rather than quoting the rule (#49).
    expect(result.stdout).toContain("(1 blocking) at `npm publish`");
    expect(result.stderr).toContain(`circle ${friendlyName} (mirror alias of ${folderSlug}, resolved from folder)`);
  });

  it("Class B + remote: a rule bound directly under the raw folder slug still wins and delivers", async () => {
    // No alias at all — the rule is bound DIRECTLY under the raw folder-hash slug (circle.ts's
    // Class B). folderSlug carries a live rule, so it is in mirror.circles, so the remote-aware
    // pick still resolves to folderSlug (no alias hop needed — the rule is already there).
    const repoDir = mkTmp();
    makeRepoWithRemote("git@github.com:acme/widgets.git", repoDir);
    const folderSlug = coreDeriveCircle(repoDir);

    mkdirSync(join(repoDir, ".monet"), { recursive: true });
    const mirrorPath = join(repoDir, ".monet", "gate-mirror.json");
    await buildCustomFixtureMirror(mirrorPath, [{
      stage: "npm publish", pattern: "Bash:npm publish", content: "Never publish without 2FA.",
      severity: "blocking", circle: folderSlug,
      reason: "a stolen token can publish a malicious version",
    }]);

    const { MONET_STORAGE_DIR: _storage, ...envWithoutStorageDir } = isolatedGateEnv({
      MONET_PROJECT_DIR: repoDir,
      HOME: gateStorageDir,
    });
    const result = spawnGateAt(repoDir, ["Bash:npm publish"], envWithoutStorageDir, "home-fallback");
    expect(result.status).toBe(GATE_EXIT_CODE.BLOCKING_DENY);
    // Circle resolution is the subject: that the deny FIRED proves the circle-scoped rule was
    // found. The payload names the stage rather than quoting the rule (#49).
    expect(result.stdout).toContain("(1 blocking) at `npm publish`");
    expect(result.stderr).toContain(`circle ${folderSlug} (resolved from folder)`);
  });

  // ── Component A (4b-D): --stdin transport ─────────────────────────────────────────────────────

  it("--stdin: a deny fires exactly as it would via the positional argument", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const result = spawnGateStdin("Bash:git push --force", ["--circle", "acme-widgets", "--mirror", mirrorPath]);
    expect(result.status).toBe(GATE_EXIT_CODE.BLOCKING_DENY);
    // Byte-identical to what the positional argument produces (the outcome-30 test above asserts
    // the same literal) — transport parity is the subject, and #49 only changed what that payload
    // says, not that the two transports must agree on it.
    expect(result.stdout).toBe(
      "Blocked by a Monet rule — 1 rule (1 blocking) at `git force push`.\n" +
        "Call stage_lookup on each before acting; this hook carries identity only, not rule text.\n",
    );
  });

  it("--stdin: an over-threshold context reaches the gate and yields a REAL exit 40 — finally reachable (argv never could carry this)", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    // Past @team-monet/core's own MAX_CONTEXT_BYTES (4 MiB). A 5 MiB argv element reliably fails
    // with E2BIG on this OS before any process even starts (see the 4b-C report) — --stdin exists
    // exactly so this class of context can still reach the gate and get an honest overflow-ask
    // instead of silently never being asked at all.
    const over = "Bash:" + "x".repeat(5 * 1024 * 1024);
    const result = spawnGateStdin(over, ["--circle", "acme-widgets", "--mirror", mirrorPath]);
    expect(result.status).toBe(GATE_EXIT_CODE.OVERFLOW_ASK);
    expect(result.stdout).toBe("");
  });

  it("P2-7 (Codex round 3 on PR #42): an input FAR past the retention cap (20 MiB, well beyond RETAINED_STDIN_CAP_BYTES) still yields the real exit 40 — draining-without-retaining does not lose the overflow outcome", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    // ~1.6x the retention cap (P1-A, round 4: cap is now 3*4MiB+64KiB ≈ 12.06 MiB, up from the
    // original 5 MiB — see RETAINED_STDIN_CAP_BYTES's own comment) — proves the CAPPED (not full)
    // retained payload, once bounded retention kicks in partway through, is STILL comfortably past
    // the 4 MiB engine threshold for this ASCII (1 byte : 1 UTF-16 unit) content, so
    // evaluateGateFromMirror's own length check still correctly reports overflow. Before P2-7's own
    // bound existed, readStdinSync retained the WHOLE 20 MiB in heap; after, it retains only up to
    // ~cap + one chunk and drains the rest. (For the DISTINCT multibyte-ratio bug this flat byte
    // cap also had — a 3-byte-UTF-8 stream needing 3x the retained bytes to reach the same decoded
    // length — see the dedicated P1-A test below.)
    const over = "Bash:" + "x".repeat(20 * 1024 * 1024);
    const result = spawnGateStdin(over, ["--circle", "acme-widgets", "--mirror", mirrorPath], {
      ...process.env,
      // spawnSync's OWN maxBuffer bounds READING the child's stdout/stderr back, not the `input`
      // being WRITTEN to it — irrelevant to a large INPUT — left at the default deliberately, to
      // also prove this test harness itself doesn't need raising (stdout stays empty either way).
    });
    expect(result.status).toBe(GATE_EXIT_CODE.OVERFLOW_ASK);
    expect(result.stdout).toBe("");
  });

  it("P1-A (Codex round 4 on PR #42): a MULTIBYTE (3-byte UTF-8) context far past the retention cap still yields the real exit 40 — a flat BYTE cap alone would evaluate this as truncated-and-normal instead (fails before this fix)", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    // "가" (U+AC00, a common Korean syllable) encodes as EXACTLY 3 UTF-8 bytes and decodes to
    // EXACTLY 1 UTF-16 code unit — the worst-case ratio RETAINED_STDIN_CAP_BYTES's own comment
    // proves is the binding constraint (3-byte sequences: 3:1; 4-byte/astral sequences: 4:2 = 2:1,
    // lower; 1- and 2-byte sequences: 1:1 and 2:1, lower still).
    //
    // 20 MiB of "가" is comfortably past BOTH the OLD flat 5 MiB byte cap AND the NEW ~12.06 MiB
    // cap, so retention is bounded (capped, not full) under either — the POINT of this test is
    // that the CAPPED retention itself must still decode past the engine's 4 Mi-unit threshold:
    //   - OLD cap (5 MiB bytes): retains at most ~5 MiB + one chunk of "가", decoding to at most
    //     ~1.75 Mi UTF-16 units — WELL UNDER the 4 Mi threshold. evaluateGateFromMirror sees a
    //     TRUNCATED context that reports IN-BOUNDS — the wrong verdict CLASS the round-4 coordinator
    //     flagged as worse than the memory bug: not "correctly flagged overflow, capped", but
    //     "silently evaluated as if normal-sized", most likely landing on silence (exit 0) or
    //     stage-hit-no-rules (exit 10) here — never the honest overflow-ask this input deserves.
    //   - NEW cap (3*4MiB+64KiB bytes): retains at least that many bytes of "가", decoding to AT
    //     LEAST ~4.02 Mi UTF-16 units — comfortably PAST the 4 Mi threshold, by construction (see
    //     RETAINED_STDIN_CAP_BYTES's own worst-case-ratio proof) — correct exit 40 regardless of
    //     how much further past the cap the genuine 20 MiB input actually goes.
    const over = "Bash:" + "가".repeat(20 * 1024 * 1024 / 3);
    const result = spawnGateStdin(over, ["--circle", "acme-widgets", "--mirror", mirrorPath], {
      ...process.env,
    });
    expect(result.status).toBe(GATE_EXIT_CODE.OVERFLOW_ASK);
    expect(result.stdout).toBe("");
  });

  it("--stdin + positional argument together: usage error, exit 1 (ambiguous — never guesses which one was meant)", () => {
    const result = spawnGate(["Bash:git push --force", "--stdin"]);
    expect(result.status).toBe(1);
    expect(result.status).not.toBe(GATE_EXIT_CODE.SILENCE);
    expect(result.stderr).toContain("given both as a positional argument and via --stdin");
  });

  it("neither positional nor --stdin: usage error, exit 1 (the pre-existing 'nothing to evaluate' refusal)", () => {
    const result = spawnGate([]);
    expect(result.status).toBe(1);
    expect(result.status).not.toBe(GATE_EXIT_CODE.SILENCE);
    expect(result.stderr).toContain("no action context given");
  });

  it("--stdin still refuses an unprefixed context, and --tool synthesis still works through it", async () => {
    const dir = mkTmp();
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);

    const unprefixed = spawnGateStdin("git push --force", ["--circle", "acme-widgets", "--mirror", mirrorPath]);
    expect(unprefixed.status).toBe(1);
    expect(unprefixed.stderr).toContain("has no 'Tool:' prefix");

    const synthesized = spawnGateStdin(
      "git push --force",
      ["--tool", "Bash", "--circle", "acme-widgets", "--mirror", mirrorPath],
    );
    expect(synthesized.status).toBe(GATE_EXIT_CODE.BLOCKING_DENY);
  });
});

// ── Unit tests for the pure/near-pure helpers (fast, no process spawn) ──────────────────────────

describe("gate-cli helpers", () => {
  it("resolveActionContextSource: exactly one of {positional, --stdin} — both or neither is a usage error", () => {
    const readStdin = () => "STDIN CONTENT";
    expect(resolveActionContextSource("Bash:foo", false, readStdin)).toEqual({ kind: "ok", raw: "Bash:foo" });
    expect(resolveActionContextSource(undefined, true, readStdin)).toEqual({ kind: "ok", raw: "STDIN CONTENT" });
    expect(resolveActionContextSource("Bash:foo", true, readStdin)).toMatchObject({ kind: "usage-error" });
    expect(resolveActionContextSource(undefined, false, readStdin)).toMatchObject({ kind: "usage-error" });
  });

  it("ensureToolPrefixedContext passes a prefixed context through unchanged", () => {
    expect(ensureToolPrefixedContext("Bash:git push --force")).toBe("Bash:git push --force");
  });

  it("runGate: --stdin on a TTY refuses with a usage error instead of hanging (readStdin never called)", () => {
    let exitCode: number | undefined;
    const stderrLines: string[] = [];
    const readStdin = () => {
      throw new Error("must not be called — this is exactly the hang this NIT fixes");
    };
    const originalError = console.error;
    console.error = (msg: string) => { stderrLines.push(msg); };
    try {
      runGate(undefined, { stdin: true }, {
        now: () => Date.now(),
        env: {},
        projectDir: () => "/tmp",
        mirrorPath: () => "/tmp/monet-gate-cli-test-does-not-exist.json",
        journalPath: () => null, // this test asserts a refusal, not a record; no file is written
        readStdin,
        isStdinTTY: () => true,
        setExitCode: (code) => { exitCode = code; },
      });
    } finally {
      console.error = originalError;
    }
    expect(exitCode).toBe(1); // the usage-error code, distinct from every GATE_EXIT_CODE outcome
    expect(stderrLines.join("\n")).toContain("stdin is a TTY");
  });

  it("ensureToolPrefixedContext synthesizes from --tool", () => {
    expect(ensureToolPrefixedContext("git push --force", "Bash")).toBe("Bash:git push --force");
  });

  it("ensureToolPrefixedContext refuses with no prefix and no --tool", () => {
    expect(() => ensureToolPrefixedContext("git push --force")).toThrow(GateActionContextError);
    expect(() => ensureToolPrefixedContext("git push --force")).toThrow(/no 'Tool:' prefix/);
  });

  it("ensureToolPrefixedContext refuses a --tool value that cannot form a valid prefix", () => {
    expect(() => ensureToolPrefixedContext("git push --force", "not valid")).toThrow(/could not be synthesized/);
  });

  it("classifyGateResult: silence only when nothing matched", () => {
    const result: GateResult = { stage: null, stages: [], rules: [], silence: true, overflow: false, source: "sidecar" };
    expect(classifyGateResult(result)).toEqual({ code: 0, label: "silence" });
  });

  it("classifyGateResult: stage-hit-no-rules is distinct from silence", () => {
    const result: GateResult = {
      stage: { id: "s1", name: "terraform apply" }, stages: [{ id: "s1", name: "terraform apply" }],
      rules: [], silence: false, overflow: false, source: "sidecar",
    };
    expect(classifyGateResult(result)).toEqual({ code: 10, label: "stage-hit-no-rules" });
  });

  it("classifyGateResult: any blocking rule present wins over advisory", () => {
    const result: GateResult = {
      stage: { id: "s1", name: "x" }, stages: [{ id: "s1", name: "x" }],
      rules: [
        { conceptId: "c1", text: "advisory one", reason: null, reasonMissing: false, severity: "advisory", scope: "domain", modelTag: null, origin: "declaration", stageId: "s1" },
        { conceptId: "c2", text: "blocking one", reason: "r", reasonMissing: false, severity: "blocking", scope: "domain", modelTag: null, origin: "declaration", stageId: "s1" },
      ],
      silence: false, overflow: false, source: "sidecar",
    };
    expect(classifyGateResult(result)).toEqual({ code: 30, label: "blocking-deny" });
  });

  it("formatMirrorAge: coarse, human-readable buckets", () => {
    const base = 1_000_000_000_000;
    expect(formatMirrorAge(base, base)).toBe("0s");
    expect(formatMirrorAge(base, base + 45_000)).toBe("45s");
    expect(formatMirrorAge(base, base + 125_000)).toBe("2m 5s");
    expect(formatMirrorAge(base, base + 3 * 3_600_000 + 61_000)).toBe("3h 1m");
    expect(formatMirrorAge(base, base + 25 * 3_600_000)).toBe("1d 1h");
  });

  it("resolveRuntimeModelTag: blank counts as absent, matching the MCP process's own reading", () => {
    expect(resolveRuntimeModelTag({})).toBeUndefined();
    expect(resolveRuntimeModelTag({ MONET_MODEL_TAG: "" })).toBeUndefined();
    expect(resolveRuntimeModelTag({ MONET_MODEL_TAG: "   " })).toBeUndefined();
    expect(resolveRuntimeModelTag({ MONET_MODEL_TAG: " model-1 " })).toBe("model-1");
  });

  it("resolveGateCircle: flag beats env beats folder derivation (no remote), and NEVER alias-advances (the evaluator owns the hop)", () => {
    const noRemote = () => "";
    expect(resolveGateCircle({
      explicitCircle: "flag-circle", env: { MONET_CIRCLE: "env-circle" }, projectDir: "/x", mirror: null,
      deriveFolderCircle: () => "folder-slug", getOriginRemote: noRemote,
    })).toEqual({ circle: "flag-circle", source: "flag" });

    expect(resolveGateCircle({
      env: { MONET_CIRCLE: "env-circle" }, projectDir: "/x", mirror: null,
      deriveFolderCircle: () => "folder-slug", getOriginRemote: noRemote,
    })).toEqual({ circle: "env-circle", source: "env" });

    // The folder slug is returned RAW even when an alias for it exists in some mirror — a second
    // pre-evaluation hop here is exactly the chained double resolution Codex r1 i3 flagged.
    const mirrorWithAlias = { circles: [], circleAliases: [{ from: "folder-slug", to: "friendly-name" }] } as unknown as GateMirror;
    expect(resolveGateCircle({
      env: {}, projectDir: "/x", mirror: mirrorWithAlias,
      deriveFolderCircle: () => "folder-slug", getOriginRemote: noRemote,
    })).toEqual({ circle: "folder-slug", source: "folder" });
  });

  // ── P1 fix (Codex round 2 on PR #40): remote-aware pick via mirror.circles membership ────────

  it("resolveGateCircle: no remote → folder slug, unchanged, regardless of mirror content", () => {
    const mirror = { circles: ["some-other-circle"], circleAliases: [] } as unknown as GateMirror;
    const resolved = resolveGateCircle({
      env: {}, projectDir: "/x", mirror,
      deriveFolderCircle: () => "folder-slug", getOriginRemote: () => "",
    });
    expect(resolved).toEqual({ circle: "folder-slug", source: "folder" });
  });

  it("resolveGateCircle: remote present, folder slug IS in mirror.circles (Class A/B-with-presence) → folder slug wins", () => {
    const mirror = { circles: ["folder-slug", "friendly-name"], circleAliases: [{ from: "folder-slug", to: "friendly-name" }] } as unknown as GateMirror;
    const resolved = resolveGateCircle({
      env: {}, projectDir: "/x", mirror,
      deriveFolderCircle: () => "folder-slug", getOriginRemote: () => "git@github.com:acme/widgets.git",
    });
    expect(resolved).toEqual({ circle: "folder-slug", source: "folder" });
  });

  it("resolveGateCircle: remote present, folder slug ABSENT from mirror.circles (the P1 case) → defaultNameFromRemote wins", () => {
    const mirror = { circles: ["github.com-acme-widgets"], circleAliases: [] } as unknown as GateMirror;
    const resolved = resolveGateCircle({
      env: {}, projectDir: "/x", mirror,
      deriveFolderCircle: () => "folder-slug-not-in-mirror", getOriginRemote: () => "git@github.com:acme/widgets.git",
    });
    expect(resolved).toEqual({ circle: "github.com-acme-widgets", source: "remote" });
  });

  it("resolveGateCircle: remote present, mirror is null (fail-open path) → defaultNameFromRemote, diagnostic-only", () => {
    const resolved = resolveGateCircle({
      env: {}, projectDir: "/x", mirror: null,
      deriveFolderCircle: () => "folder-slug", getOriginRemote: () => "git@github.com:acme/widgets.git",
    });
    expect(resolved).toEqual({ circle: "github.com-acme-widgets", source: "remote" });
  });

  it("describeResolvedCircle: mirrors the evaluator's single display hop; raw when no mirror is in hand", () => {
    const mirror = { circleAliases: [{ from: "folder-slug", to: "friendly-name" }] } as unknown as GateMirror;
    const resolved = { circle: "folder-slug", source: "folder" as const };
    expect(describeResolvedCircle(resolved, mirror)).toBe("friendly-name (mirror alias of folder-slug, resolved from folder)");
    expect(describeResolvedCircle(resolved, null)).toBe("folder-slug (resolved from folder)");
    expect(describeResolvedCircle({ circle: "named", source: "flag" }, mirror)).toBe("named (resolved from flag)");
    // The display hop applies identically to a "remote"-sourced circle: a renamed default-name
    // circle resolves via the alias map exactly like any other input (no mechanical change needed
    // in describeResolvedCircle itself for the P1 fix — this pins that claim).
    const remoteResolved = { circle: "github.com-acme-widgets", source: "remote" as const };
    expect(describeResolvedCircle(remoteResolved, null)).toBe("github.com-acme-widgets (resolved from remote)");
    const aliasedRemoteMirror = { circleAliases: [{ from: "github.com-acme-widgets", to: "acme-widgets" }] } as unknown as GateMirror;
    expect(describeResolvedCircle(remoteResolved, aliasedRemoteMirror)).toBe(
      "acme-widgets (mirror alias of github.com-acme-widgets, resolved from remote)",
    );
  });

  it("resolveGateCircle: uses @team-monet/core's own deriveCircle and remote-circle.ts's getOriginRemote by default (pure functions of the path)", () => {
    // REPO_ROOT is this repo's own checkout — a real git dir, so the real getOriginRemote runs a
    // real (local, no-network) `git remote get-url origin`. Whatever it returns, the assertion
    // below holds either way: no remote → folder; remote present → folder is in mirror.circles
    // (mirror: null here, so the membership check is trivially false) → remote per this repo's
    // own defaultNameFromRemote, UNLESS the folder slug happens to be in a null mirror's circles
    // (impossible — null has none). So with mirror: null the outcome is fully determined by
    // whether this checkout has an origin remote at all.
    const resolved = resolveGateCircle({ env: {}, projectDir: REPO_ROOT, mirror: null });
    const remote = getOriginRemote(REPO_ROOT);
    if (remote) {
      expect(resolved).toEqual({ circle: defaultNameFromRemote(remote), source: "remote" });
    } else {
      expect(resolved).toEqual({ circle: coreDeriveCircle(REPO_ROOT), source: "folder" });
    }
  });

  it("readGateMirrorFile: missing file", () => {
    const result = readGateMirrorFile(join(mkdtempSync(join(tmpdir(), "monet-gate-read-")), "nope.json"));
    expect(result.kind).toBe("missing");
  });

  it("readGateMirrorFile: not valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-gate-read-"));
    const p = join(dir, "bad.json");
    writeFileSync(p, "{ not json");
    const result = readGateMirrorFile(p);
    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") expect(result.reason).toContain("not valid JSON");
    rmSync(dir, { recursive: true, force: true });
  });

  it("readGateMirrorFile: valid JSON but wrong shape (the read-path-throw class)", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-gate-read-"));
    const p = join(dir, "bad-shape.json");
    writeFileSync(p, JSON.stringify({ format: 4, generation: 1, generatedAt: 1, entries: [] }));
    const result = readGateMirrorFile(p);
    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") expect(result.reason).toContain("array");
    rmSync(dir, { recursive: true, force: true });
  });

  it("readGateMirrorFile: a real mirror round-trips as ok, and a checksum flip is caught", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-gate-read-"));
    const mirrorPath = join(dir, "gate-mirror.json");
    await buildFixtureMirror(mirrorPath);
    const ok = readGateMirrorFile(mirrorPath);
    expect(ok.kind).toBe("ok");

    const raw = readFileSync(mirrorPath, "utf8");
    const flippedChecksum = raw.replace(/"checksum": "([0-9a-f])/, (_m, c: string) => `"checksum": "${c === "0" ? "1" : "0"}`);
    expect(flippedChecksum).not.toBe(raw);
    const badPath = join(dir, "bad-checksum.json");
    writeFileSync(badPath, flippedChecksum);
    const bad = readGateMirrorFile(badPath);
    expect(bad.kind).toBe("malformed");
    if (bad.kind === "malformed") expect(bad.reason).toContain("checksum mismatch");
    rmSync(dir, { recursive: true, force: true });
  });

  it("P2-7 (Codex round 3 on PR #42), unit: readStdinSync's own RETAINED size never exceeds RETAINED_STDIN_CAP_BYTES + one chunk (65536), however much is actually piped in", () => {
    // Mocks fs.readSync (the SAME `fs` default-import object gate-cli.ts itself calls through —
    // Node's module cache means both this test and gate-cli.ts hold the identical object
    // reference, so a spy installed here intercepts gate-cli.ts's own calls too) to feed
    // readStdinSync a CONTROLLED, effectively-unbounded stream (64 KiB chunks, "fed" forever)
    // without needing a real multi-hundred-MB piped stdin — proving the RETENTION bound
    // algorithmically, deterministically, and fast, rather than only inferring it from an
    // external process's memory footprint.
    const CHUNK = 65536;
    const totalChunksToOffer = Math.ceil((RETAINED_STDIN_CAP_BYTES * 4) / CHUNK); // ~4x the cap
    let chunksServed = 0;
    const readSyncSpy = vi.spyOn(fs, "readSync").mockImplementation(((
      _fd: number,
      buffer: NodeJS.ArrayBufferView,
      _offset: number,
      length: number,
    ): number => {
      if (chunksServed >= totalChunksToOffer) return 0; // EOF
      chunksServed += 1;
      // Fill with a recognizable byte; content doesn't matter, only length does for this test.
      (buffer as Buffer).fill(0x78, 0, length); // 'x'
      return length;
    }) as typeof fs.readSync);

    try {
      const result = readStdinSync();
      const retainedBytes = Buffer.byteLength(result, "utf8");
      expect(retainedBytes).toBeLessThanOrEqual(RETAINED_STDIN_CAP_BYTES + CHUNK);
      // Not vacuous: confirm the mock actually offered MORE than the cap (so bounding was
      // genuinely exercised, not just "nothing was retained because nothing was fed").
      expect(chunksServed * CHUNK).toBeGreaterThan(RETAINED_STDIN_CAP_BYTES + CHUNK);
      // And confirm draining actually continued to true EOF (every offered chunk was consumed,
      // not just abandoned mid-stream) — the mock only returns 0 once chunksServed reaches the
      // total, so reaching this point at all proves the loop kept calling readSync past the cap.
      expect(chunksServed).toBe(totalChunksToOffer);
    } finally {
      readSyncSpy.mockRestore();
    }
  });
});

// ── remote-circle.ts: the P1 fix's extracted module (Codex round 2 on PR #40) ───────────────────

describe("remote-circle.ts (extracted P1 helpers)", () => {
  it("canonicalRemoteKey/defaultNameFromRemote: canonical examples pinned (reusing circle.ts's own documented rules — see circle.test.ts for the exhaustive suite)", () => {
    // SSH scp-form → host/org/repo.
    expect(canonicalRemoteKey("git@github.com:team-monet/monet-core.git")).toBe("github.com/team-monet/monet-core");
    // HTTPS with userinfo → stripped (security requirement — must never survive into a circle name).
    expect(canonicalRemoteKey("https://user:pat@github.com/acme/widgets.git")).toBe("github.com/acme/widgets");
    // defaultNameFromRemote: full host-org-repo slug, hyphenated.
    expect(defaultNameFromRemote("git@github.com:acme/widgets.git")).toBe("github.com-acme-widgets");
  });

  it("getOriginRemote: empty string on a non-git directory, never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "example-remote-circle-"));
    expect(getOriginRemote(dir)).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });

  it("import purity: no better-sqlite3/db import in remote-circle.ts's own source, and it works standalone in a fresh process", () => {
    const source = readFileSync(join(REPO_ROOT, "src", "remote-circle.ts"), "utf8");
    // Checked as an IMPORT SPECIFIER, not a bare substring — this module's own doc comment
    // legitimately names "better-sqlite3" in prose (explaining why it must NOT be imported), so a
    // naive .not.toContain would false-positive on that very sentence.
    expect(source).not.toMatch(/from\s+["']better-sqlite3["']/);
    expect(source).not.toMatch(/from\s+["']\.\/db\//);
    expect(source).not.toMatch(/from\s+["'](\.\/)?circle(\.js)?["']/);

    // Runtime smoke: a FRESH process importing ONLY this module — nothing else from gate-cli.ts's
    // or circle.ts's own graph, no MonetCore, no better-sqlite3 — still works end to end. This is
    // the actual "no sqlite in the graph" claim gate-cli.ts's own module comment makes, verified
    // rather than assumed.
    const dir = mkdtempSync(join(tmpdir(), "example-remote-circle-purity-"));
    const scriptPath = join(dir, "purity-check.mjs");
    const modulePath = join(REPO_ROOT, "src", "remote-circle.ts");
    writeFileSync(scriptPath, `
      import { getOriginRemote, canonicalRemoteKey, defaultNameFromRemote } from ${JSON.stringify(modulePath)};
      console.log(JSON.stringify({
        hasGetOriginRemote: typeof getOriginRemote === "function",
        hasCanonicalRemoteKey: typeof canonicalRemoteKey === "function",
        hasDefaultNameFromRemote: typeof defaultNameFromRemote === "function",
        pin: defaultNameFromRemote("git@github.com:acme/widgets.git"),
        emptyOnNonGitDir: getOriginRemote(${JSON.stringify(dir)}),
      }));
    `);
    const result = spawnSync(process.execPath, ["--import", TSX_LOADER, scriptPath], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      hasGetOriginRemote: true,
      hasCanonicalRemoteKey: true,
      hasDefaultNameFromRemote: true,
      pin: "github.com-acme-widgets",
      emptyOnNonGitDir: "",
    });
    rmSync(dir, { recursive: true, force: true });
  });
});
