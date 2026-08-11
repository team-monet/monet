/**
 * Rules, stages and the gate engine.
 *
 * The load-bearing guarantees this suite exists to pin, in the order the design states them:
 *
 *   1. A RULE IS BORN AT A CORRECTION, and the stage is born with it when the action has none.
 *   2. A CORRECTION THAT OVERTURNS A RULE births its successor and supersedes the incumbent IN THE
 *      SAME ACT — so a gate never returns two contradicting rules, and the old rule stays as
 *      history without ever being injected again.
 *   3. BLOCKING IS DECLARATION-ONLY, in both directions: no agent can mint deny power through
 *      capture, and no agent can remove it through correction.
 *   4. THE FIRING PATH IS DETERMINISTIC — the same action asks the same question and gets the same
 *      answer, with no model, no network and no embedder anywhere in it.
 *
 * The pattern fixtures near the top are the contract for the format itself: they are what a human
 * reads to predict firing, so they are asserted directly rather than through the engine.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import * as nodeCrypto from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MonetCore } from "../engine";
import { registerMonetCoreTools } from "../mcp-server";
import { renderOverview } from "../render-overview";
import {
  bindRule,
  BREADTH_CIRCLE,
  COMMAND_BOUNDARY,
  createGateSchema,
  evaluateGate,
  evaluateGateFromMirror,
  evaluateStageLookup,
  formatTriggerPattern,
  gateGeneration,
  gateQuery,
  gateStats,
  GATE_MIRROR_FORMAT,
  LEGACY_STAR_CIRCLE,
  migrateGateColumns,
  readTriggerPatterns,
  upsertStage,
  liveStageIndex,
  matchesTriggerPattern,
  MODEL_TAG_MAX_CHARS,
  normalizeMatchToken,
  normalizeStageName,
  parseActionContext,
  parseTriggerPatterns,
  seedTriggerPattern,
  stageLookup as standaloneStageLookup,
  STAGE_INDEX_CAP,
  STAGE_LOOKUP_BODY_CAP,
  STAGE_LOOKUP_REASON_CAP,
  STAGE_LOOKUP_RULES_CAP,
  STAGE_NAME_MAX_CHARS,
} from "../gates";
import type { GateMirror, SidecarMaterialization } from "../gates";
import type { EmbeddingProvider } from "../embedding";
import type { StoragePort } from "../storage";
import { BetterSqlitePort, type Statement } from "../storage";
import { formatSpan } from "../spans";

// WRAPS, NEVER REPLACES, `randomUUID` (Codex round 9, item 1's own tests) — a plain `vi.spyOn` on
// the imported "node:crypto" namespace throws ("Module namespace is not configurable in ESM"):
// Node's own built-in module namespace objects are frozen, unlike vite-transformed source modules.
// `vi.mock` intercepts at RESOLUTION instead, before gates.ts's own `import { randomUUID }` ever
// binds — but `engine.ts` calls the SAME `randomUUID` for every concept/device id this entire file
// mints (`this.newId = opts.idGen ?? randomUUID`), so the mock defaults to CALLING THROUGH to the
// real implementation (`vi.fn(actual.randomUUID)`), and only ever gets a `mockReturnValueOnce`
// layered on top, immediately before the ONE call a given test means to control, consumed by that
// call alone. Never `mockReturnValue` (persistent) or `mockReset` here — either would silently
// break id generation for every test that runs after, file-wide.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

/** Dedup DISABLED: every store() yields its own concept. */
function core(opts: { syncDeviceId?: string; circle?: string } = {}): MonetCore {
  return new MonetCore(":memory:", {
    tauAttach: 1.1,
    tauAmbiguous: 1.1,
    syncDeviceId: opts.syncDeviceId,
    defaultCircle: opts.circle,
  });
}

/** Dedup ENABLED at the embedder's own calibrated thresholds — identical text resolves together. */
function resolvingCore(opts: { syncDeviceId?: string } = {}): MonetCore {
  return new MonetCore(":memory:", { syncDeviceId: opts.syncDeviceId });
}

class ConstantEmbeddingProvider implements EmbeddingProvider {
  readonly dim = 2;
  readonly modelId = "test:constant";
  embed(): Float32Array { return new Float32Array([1, 0]); }
}

type RawDb = { prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] } };
const raw = (c: MonetCore): RawDb => (c as unknown as { db: RawDb }).db;

const tmpDirs: string[] = [];
function mkTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "monet-gates-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const AGENT_RULE = { scope: "agent", modelTag: "test-model-1" } as const;

/**
 * Seed `count` ratified principles as a RAW-SQL FIXTURE — rows shaped exactly as `skeleton()` reads
 * them — rather than by driving `store()` + `ratify()` once per entry.
 *
 * WHY (CI fix): the truncation test needs a few hundred skeleton members purely as BULK, and its
 * subject is the wire's own fit-and-signal, not the write pipeline. Seeding them for real ran the
 * full resolution pipeline per entry, whose candidate scan grows with the store — effectively
 * O(n²) per sweep step — and better-sqlite3 is synchronous, so on a slow runner that became a long
 * near-synchronous stretch that starved the vitest worker's RPC timers: every assertion passed and
 * the run still died with `[vitest-worker]: Timeout calling "onTaskUpdate"`. Raw inserts make the
 * same fixture in one transaction. (Raw-SQL fixture building has precedent in
 * lifecycle-edges.test.ts's own CHECK-constraint tests.)
 *
 * THE EMBEDDING IS BORROWED FROM A REAL WRITE, never hand-built: exactly ONE `store()` + `ratify()`
 * pair runs for real, and that row's own embedding blob is reused for every raw row. This keeps the
 * fixture's vector width and JSON encoding identical to what this engine actually writes — which
 * matters, because a later REAL `memory_declare` against this store parses every one of them
 * through `bestMatches`. Guessing that format is the one thing that would make the shortcut
 * unsound. Both callers use dedup-disabled cores (`core()`: tauAttach/tauAmbiguous 1.1), so
 * identical vectors never merge or pair.
 *
 * Returns the total number of ratified principles seeded, for the caller's own sanity assertion.
 */
async function seedRatifiedPrinciples(c: MonetCore, count: number, body: (i: number) => string): Promise<number> {
  const db = (c as unknown as { db: StoragePort }).db;
  // THE ONE REAL WRITE — the fixture's reference row, and the source of the embedding blob below.
  const real = await c.store(body(0), { kind: "principle" });
  await c.ratify({ candidateId: real.conceptId, verdict: "approve" });
  const embedding = (db.prepare(`SELECT embedding FROM concepts WHERE id = ?`)
    .get(real.conceptId) as { embedding: string }).embedding;

  const insertConcept = db.prepare(
    `INSERT INTO concepts (id, slug, title, body, kind, embedding, support_count, version, dirty, circle)
     VALUES (?, ?, ?, ?, 'principle', ?, 1, 0, 1, 'default')`,
  );
  const insertRatification = db.prepare(
    `INSERT INTO ratifications (id, subject_concept_id, verdict, packet, ratified_by, circle, created_at, sync_updated_at)
     VALUES (?, ?, 'approve', NULL, 'fixture', 'default', ?, ?)`,
  );
  // Column list mirrors `create()`'s own INSERT (engine.ts) minus the columns skeleton() cannot
  // see; created_at is strictly increasing AND far below the engine's live sync clock, so every
  // real write that follows sorts after the whole fixture under skeleton()'s oldest-first order.
  db.transaction(() => {
    for (let i = 1; i < count; i++) {
      const conceptId = `fixture-concept-${i}`;
      const text = body(i);
      insertConcept.run(conceptId, `fixture-${i}`, text.slice(0, 80), text, embedding);
      insertRatification.run(`fixture-ratification-${i}`, conceptId, i, i);
    }
  })();
  return count;
}

/**
 * Withdraw a deny the way the doctrine says it must be withdrawn: an explicit declaration on THAT
 * rule. `declare` resolves its target by content, which forks on a dedup-disabled core, so this
 * names the concept directly — the same declaration write path, aimed rather than resolved.
 *
 * Every test that needs to retire, delete or merge a blocking rule goes through here first, which
 * is itself the point: after the chokepoint there is no other way, including for tests.
 */
async function withdrawDeny(c: MonetCore, conceptId: string, stage: string, circle?: string): Promise<void> {
  await c.store("Withdrawn by declaration.", {
    circle,
    kind: "rule",
    attachTo: conceptId,
    rule: { stage, severity: "advisory", declaration: true, ...AGENT_RULE },
  });
}

// ---------------------------------------------------------------------------
// the pattern format — the contract a human reads
// ---------------------------------------------------------------------------
describe("trigger pattern format", () => {
  it("seeds `Bash: git push --force` from the instance the correction was captured on", () => {
    const pattern = seedTriggerPattern("Bash:git push --force origin main");
    expect(pattern).toEqual({ tool: "bash", tokens: ["git", "push", "--force"] });
    expect(formatTriggerPattern(pattern)).toBe("bash: git push --force");
  });

  it("fires on the dangerous shape and stays silent on its safe siblings (the slice's fixtures)", () => {
    const pattern = seedTriggerPattern("Bash:git push --force origin main");
    const fires = (context: string): boolean => matchesTriggerPattern(pattern, parseActionContext(context));

    // Fires: a prefix of the captured instance...
    expect(fires("Bash:git push --force")).toBe(true);
    // ...and the same command buried mid-chain behind a `cd`, with different operands.
    expect(fires("Bash:cd /x && git push --force origin dev")).toBe(true);
    // Silent: the same tool and the same leading word, but not this command.
    expect(fires("Bash:git status")).toBe(false);
    // Silent: a different tool entirely.
    expect(fires("Read:/etc/hosts")).toBe(false);
  });

  it("fires a declared `terraform apply` stage on `Bash:terraform apply -auto-approve`", () => {
    // A declaration authored from a bare command name gets no tool constraint, which is what lets
    // it fire on whichever host surface actually runs it.
    const pattern = seedTriggerPattern("terraform apply");
    expect(pattern).toEqual({ tool: null, tokens: ["terraform", "apply"] });
    expect(matchesTriggerPattern(pattern, parseActionContext("Bash:terraform apply -auto-approve"))).toBe(true);
    expect(matchesTriggerPattern(pattern, parseActionContext("Bash:terraform plan"))).toBe(false);
  });

  it("seeds from the substantive command in a chain, whichever end it sits at", () => {
    expect(seedTriggerPattern("Bash:cd /x && git push --force origin dev").tokens)
      .toEqual(["git", "push", "--force"]);
    expect(seedTriggerPattern("Bash:git push --force && echo done").tokens)
      .toEqual(["git", "push", "--force"]);
  });

  it("keeps a quoted run as one token, so message text never leaks into a pattern", () => {
    // ONE token, and it carries the quoted CONTENT rather than the quotes: `-m "a b"` can never be
    // confused with the three-token `-m a b`, and the quotes themselves are not part of the word.
    expect(parseActionContext(`Bash:git commit -m "fix the thing"`).tokens)
      .toEqual(["git", "commit", "-m", "fix the thing"]);
    expect(seedTriggerPattern(`Bash:git commit -m "fix the thing"`).tokens)
      .toEqual(["git", "commit", "-m"]);
  });

  it("sees through quoting and escaping — the same command to the shell is the same command here", () => {
    const pattern = seedTriggerPattern("Bash:git push --force origin main");
    const fires = (context: string): boolean => matchesTriggerPattern(pattern, parseActionContext(context));
    expect(fires(`Bash:git "push" --force origin main`)).toBe(true);
    expect(fires(`Bash:git 'push' '--force' origin main`)).toBe(true);
    expect(fires(`Bash:git push \\-\\-force origin main`)).toBe(true);
    expect(fires("Bash:GIT PUSH --FORCE origin main")).toBe(true);
    // ACCEPTED NON-MATCHES, documented in the module header rather than half-fixed.
    // Genuinely different tokens — teaching the matcher otherwise means teaching it every tool's
    // flag grammar, which is how a deterministic matcher becomes a heuristic one.
    expect(fires("Bash:git push --force=true origin main")).toBe(false);
    expect(fires("Bash:git push -f origin main")).toBe(false);
    // ANSI-C quoting. `$'...'` carries its own escape table, and a partial implementation is worse
    // than none: stripping the `$` and treating the run as literal would render `$'a\nb'` as four
    // characters where the shell produces two words. Left alone, deliberately, and pinned here so
    // the day someone implements the escape table in full, this test is what they update.
    expect(fires("Bash:$'git' push --force origin main")).toBe(false);
  });

  it("processes shell escapes EXACTLY ONCE, so a literal backslash survives", () => {
    // `foo\\bar` is the five characters `foo\bar` to the shell. The tokenizer resolved that
    // correctly and then normalizeMatchToken unescaped the result a SECOND time, yielding
    // `foobar` — a token that matches things it should not and misses the one it should.
    expect(parseActionContext("Bash:foo\\\\bar").tokens).toEqual(["foo\\bar"]);
    expect(seedTriggerPattern("Bash:foo\\\\bar --flag").tokens).toEqual(["foo\\bar", "--flag"]);
    // Seed and match agree because both come through the same tokenizer.
    expect(matchesTriggerPattern(
      seedTriggerPattern("Bash:foo\\\\bar --flag"),
      parseActionContext("Bash:foo\\\\bar --flag now"),
    )).toBe(true);
    // ...and a token whose literal content IS a quoted string keeps its quotes.
    expect(parseActionContext(`Bash:echo '"quoted"'`).tokens).toEqual(["echo", '"quoted"']);
    // The single-escape cases still resolve, once.
    expect(parseActionContext("Bash:a\\ b").tokens).toEqual(["a b"]);
    expect(parseActionContext("Bash:git push \\-\\-force").tokens).toEqual(["git", "push", "--force"]);
  });

  it("normalizes BOTH sides with one function, so a stored pattern cannot drift from the matcher", () => {
    // The shared form is CASE FOLDING ONLY, and that is what makes it idempotent. Quote-stripping
    // and unescaping belong to the TOKENIZER, which is the only layer that knows which characters
    // were syntax and which were data — see the double-processing test below.
    expect(normalizeMatchToken('"push"')).toBe('"push"');
    expect(normalizeMatchToken("--Force")).toBe("--force");
    // What matters is that both sides agree, which they do because both come through the tokenizer.
    const stored = readTriggerPatterns(JSON.stringify([{ tool: "Bash", tokens: ["GIT", "Push"] }])).patterns;
    expect(stored).toEqual([{ tool: "bash", tokens: ["git", "push"] }]);
    expect(matchesTriggerPattern(stored[0]!, parseActionContext("Bash:git push --force"))).toBe(true);
  });

  it("refuses a seed that is nothing but flags — that stage would address every command", () => {
    // K1: `--force` alone fires on `rm -rf --force`, on `git push --force`, on anything carrying
    // the flag. Born pattern-less and inert instead, visible in the dead-pattern watchlist.
    expect(seedTriggerPattern("Bash:--force").tokens).toEqual([]);
    expect(seedTriggerPattern("--force -v").tokens).toEqual([]);
    expect(matchesTriggerPattern(seedTriggerPattern("Bash:--force"), parseActionContext("Bash:rm -rf --force")))
      .toBe(false);
    // A flag run that DOES have a word reaches for it rather than giving up.
    expect(seedTriggerPattern("Bash:-v --force rm").tokens).toEqual(["-v", "--force", "rm"]);
  });

  it("matches the whole context — a wall of padding cannot push the command out of view", () => {
    // F1: the old token clamp meant N tokens of padding silenced every gate in the store. A cap
    // that turns "long" into "ungoverned" is worse than no cap.
    const pattern = seedTriggerPattern("Bash:git push --force origin main");
    const padding = Array.from({ length: 4000 }, (_, i) => `arg${i}`).join(" ");
    expect(matchesTriggerPattern(pattern, parseActionContext(`Bash:${padding} && git push --force origin main`)))
      .toBe(true);
  });

  it("only reads a tool prefix when the text before the colon is a bare identifier", () => {
    expect(parseActionContext(`psql -c "select 1:2"`).tool).toBeNull();
    expect(parseActionContext("Bash:ls").tool).toBe("bash");
  });

  it("never matches on an empty token run — a stage that fires on everything is worse than none", () => {
    expect(matchesTriggerPattern({ tool: null, tokens: [] }, parseActionContext("Bash:anything at all"))).toBe(false);
    expect(matchesTriggerPattern({ tool: "bash", tokens: [] }, parseActionContext("Bash:anything at all"))).toBe(false);
  });

  it("reads a corrupt stage row as zero patterns instead of throwing on the firing path", () => {
    expect(parseTriggerPatterns("not json at all")).toEqual([]);
    expect(parseTriggerPatterns('{"tool":"bash"}')).toEqual([]);
    expect(parseTriggerPatterns('[{"tool":"Bash","tokens":["GIT","Push"]},{"nope":1}]'))
      .toEqual([{ tool: "bash", tokens: ["git", "push"] }]);
  });
});

// ---------------------------------------------------------------------------
// rule birth
// ---------------------------------------------------------------------------
describe("rule capture", () => {
  it("creates the concept, births the stage, and binds them", async () => {
    const c = core();
    const stored = await c.store("Never force-push to a shared branch.", {
      kind: "rule",
      rule: {
        stage: "git force push",
        instance: "Bash:git push --force origin main",
        reason: "it destroys teammates' commits",
        ...AGENT_RULE,
      },
    });

    const binding = c.ruleBinding(stored.conceptId)!;
    expect(binding).toMatchObject({
      stage_id: expect.any(String),
      severity: "advisory",
      scope: "agent",
      model_tag: "test-model-1",
      origin: "correction",
      reason: "it destroys teammates' commits",
      declared_by: null,
    });

    // The stage did not exist a moment ago: the correction's landing on an unstaged action IS its
    // creation, and its pattern comes from the instance that was visible at that moment.
    const stages = c.stages();
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({ name: "git force push", origin: "correction", verified: false });
    expect(stages[0]!.patterns).toEqual([{ tool: "bash", tokens: ["git", "push", "--force"] }]);
    expect(stored.concept.kind).toBe("rule");
    c.close();
  });

  it("takes the rule's address from an existing stage rather than creating a second one", async () => {
    const c = core();
    const first = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    const second = await c.store("Announce in the channel before any force push.", {
      // Named by a DIFFERENT spelling of the same stage — normalization is what keeps the stage set
      // "finite, slow-growing, countable".
      kind: "rule", rule: { stage: "  Git   Force Push ", instance: "Bash:git push --force -u origin x", ...AGENT_RULE },
    });
    expect(c.stages()).toHaveLength(1);
    expect(c.ruleBinding(first.conceptId)!.stage_id).toBe(c.ruleBinding(second.conceptId)!.stage_id);
    // The incumbent stage keeps its own patterns: a later capture does not re-author an address.
    expect(c.stages()[0]!.patterns).toEqual([{ tool: "bash", tokens: ["git", "push", "--force"] }]);
    c.close();
  });

  /**
   * NARROWED TO THE SAME STAGE (review fix — Codex 5-B round 2, R2-6). The invariant this test
   * exists for — an incidental repeat must not re-address a live rule — is unchanged, and so is the
   * one-rule-two-observations outcome when the repeat names the SAME moment. What changed is the
   * CROSS-stage case it used to assert here: that no longer attaches at all, it forks, because "a
   * rule repeating across stages is still a rule" and stage B deserves its own. The incumbent's
   * address still does not move (it is not even the write's target any more), and the fork's own
   * contract is pinned in "5-B: a rule repeating across stages forks instead of absorbing".
   */
  it("a rule corrected twice at ONE stage is two observations, one rule — and its address does not move", async () => {
    const c = resolvingCore();
    const first = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    const second = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force -u origin x", ...AGENT_RULE },
    });

    expect(second.conceptId).toBe(first.conceptId);
    expect(second.action).toBe("attached");
    expect(second.concept.supportCount).toBe(2);
    // The rule's address did NOT move, and the repeat's own instance did not re-author the stage's
    // patterns either: a later capture does not re-address a live rule by either mechanism.
    expect(c.stages().map((s) => s.name)).toEqual(["git force push"]);
    expect(c.stages()[0]!.patterns).toEqual([{ tool: "bash", tokens: ["git", "push", "--force"] }]);
    const bound = c.stages().find((s) => s.id === c.ruleBinding(first.conceptId)!.stage_id)!;
    expect(bound.name).toBe("git force push");
    c.close();
  });

  /**
   * THE KEEP BRANCH IS NOW REACHED BY AN ASSERTED IDENTITY (review fix — Codex 5-B round 2, R2-6).
   * `captureRuleBinding`'s "no stage for a binding that will not use it" guard is unchanged and
   * still load-bearing; what changed is which caller can get there while naming another action. An
   * AUTO-resolved cross-stage capture forks now (so its stage is created and BOUND — never an
   * orphan), leaving explicit `attachTo` as the path that keeps the incumbent binding while naming
   * a different stage, which is exactly the shape that would strand one.
   */
  it("creates no orphan stage when the binding it would serve is kept", async () => {
    const c = resolvingCore();
    const first = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    // A named attach whose rule options name a DIFFERENT action keeps the incumbent binding — and
    // used to leave the newly named stage behind, unbound: it fires nothing, can never fire
    // anything, and sits on the dead-pattern watchlist forever.
    await c.store("Never force-push to a shared branch.", {
      kind: "rule", attachTo: first.conceptId, rule: { stage: "some other gate", instance: "Bash:rm -rf", ...AGENT_RULE },
    });
    expect(c.stages().map((s) => s.name)).toEqual(["git force push"]);
    expect(c.gateStats().unverifiedPatterns.map((u) => u.stageName)).toEqual(["git force push"]);
    expect(c.ruleBinding(first.conceptId)!.stage_id).toBe(c.stages()[0]!.id);

    // A DECLARATION still moves the address, stage and all — that is the sovereign path.
    await c.declare({
      species: "rule", stage: "some other gate", patterns: ["Bash:rm -rf"],
      content: "Never force-push to a shared branch.", ...AGENT_RULE,
    });
    expect(c.stages().map((s) => s.name).sort()).toEqual(["git force push", "some other gate"]);
    expect(c.stages().find((s) => s.id === c.ruleBinding(first.conceptId)!.stage_id)!.name).toBe("some other gate");
    c.close();
  });

  it("refuses a rule with no stage, and a stage option with no rule kind", async () => {
    const c = core();
    await expect(c.store("A rule with nowhere to fire.", { kind: "rule" }))
      .rejects.toThrow(/requires rule\.stage/);
    await expect(c.store("Not a rule.", { kind: "fact", rule: { stage: "x", ...AGENT_RULE } }))
      .rejects.toThrow(/requires kind "rule"/);
    c.close();
  });

  it("requires a model tag on an agent-scoped rule, and forbids one on a domain rule", async () => {
    const c = core();
    await expect(c.store("Compensation with no model named.", { kind: "rule", rule: { stage: "s", scope: "agent" } }))
      .rejects.toThrow(/requires rule\.modelTag/);
    const domain = await c.store("True for a perfect agent.", { kind: "rule", rule: { stage: "s", scope: "domain" } });
    expect(c.ruleBinding(domain.conceptId)).toMatchObject({ scope: "domain", model_tag: null });
    c.close();
  });

  it("will not absorb a rule into a FACT it happens to paraphrase — it forks and pairs instead", async () => {
    const c = resolvingCore();
    const fact = await c.store("Always run terraform plan before apply.", { kind: "fact" });
    // Identical text, so the nomination scan picks the fact — but a binding on a fact would be
    // accepted, stored, and never delivered, because the gate only ever returns kind='rule'.
    const rule = await c.store("Always run terraform plan before apply.", {
      kind: "rule", rule: { stage: "terraform apply", instance: "Bash:terraform apply", ...AGENT_RULE },
    });
    expect(rule.conceptId).not.toBe(fact.conceptId);
    expect(rule.action).toBe("created");
    expect(rule.concept.kind).toBe("rule");
    expect(c.gate({ actionContext: "Bash:terraform apply -auto-approve" }).rules).toHaveLength(1);
    // The near-match is not discarded: the pair goes to the same curation surface every other
    // non-merge goes to.
    expect(rule.nearMatchId).toBe(fact.conceptId);
    expect(c.overview("default").possibleDuplicates.map((p) => [p.conceptAId, p.conceptBId].sort()))
      .toEqual([[fact.conceptId, rule.conceptId].sort()]);
    c.close();
  });

  it("will not attach fresh rule evidence to a SUPERSEDED rule — history takes no new evidence", async () => {
    const c = resolvingCore();
    const original = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    await c.store("Force-push is fine on your own branch; never on a shared one.", {
      kind: "correction", attachTo: original.conceptId,
    });
    // Re-noticing the original rule must not vanish into the concept the gate is required never to
    // inject again.
    const recaptured = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", ...AGENT_RULE },
    });
    expect(recaptured.conceptId).not.toBe(original.conceptId);
    expect(c.gate({ actionContext: "Bash:git push --force" }).rules.map((r) => r.conceptId))
      .toContain(recaptured.conceptId);

    // And naming the dead rule explicitly is a caller error, not something to route around quietly.
    await expect(c.store("More evidence for the dead rule.", { kind: "rule", attachTo: original.conceptId, rule: { stage: "git force push", ...AGENT_RULE } }))
      .rejects.toThrow(/superseded and is retained as history/);
    await expect(c.store("A rule on a fact.", { kind: "rule", attachTo: (await c.store("An unrelated fact.", { kind: "fact" })).conceptId, rule: { stage: "s", ...AGENT_RULE } }))
      .rejects.toThrow(/is a 'fact', not a rule/);
    c.close();
  });

  it("REFUSES a blocking severity on the capture surface, and says where deny power comes from", async () => {
    const c = core();
    await expect(
      c.store("Never run this.", {
        kind: "rule",
        // Cast: the type already forbids it. The runtime guard is the one that matters, because an
        // MCP caller reaches this path with an unchecked string.
        rule: { stage: "danger", severity: "blocking" as unknown as "advisory", ...AGENT_RULE },
      }),
    ).rejects.toThrow(/blocking is declaration-only.*memory_declare/s);
    expect(raw(c).prepare(`SELECT COUNT(*) AS n FROM rule_bindings`).get()).toEqual({ n: 0 });
    c.close();
  });
});

// ---------------------------------------------------------------------------
// rule death
// ---------------------------------------------------------------------------
describe("rule death — a correction supersedes rather than attaches", () => {

  it("treats a NOMINATED landing on a rule exactly like a named one", async () => {
    const c = resolvingCore();
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    // No attachTo: the resolution hybrid decides WHICH concept this lands on; what landing MEANS is
    // a property of what it landed on.
    const correction = await c.store("Never force-push to a shared branch.", { kind: "correction" });
    expect(correction.ruleSuccession?.supersededRuleId).toBe(rule.conceptId);
    expect(correction.conceptId).not.toBe(rule.conceptId);
    expect(correction.contradiction).toBeUndefined();
    c.close();
  });

  it("REFUSES to correct a blocking rule — declaration is its only mutation path", async () => {
    const c = core();
    const declared = await c.declare({
      species: "rule",
      stage: "terraform apply",
      content: "Never apply to production without a plan review.",
      severity: "blocking",
      reason: "an unreviewed apply changes production before anyone has agreed to it",
      ...AGENT_RULE,
    });
    const conceptId = declared.species === "rule" ? declared.conceptId : "";

    await expect(c.store("Actually it's fine sometimes.", { kind: "correction", attachTo: conceptId }))
      .rejects.toThrow(/blocking rule and cannot be corrected/);

    // The refusal rolled back cleanly: no orphan successor, no supersession, deny power intact.
    expect(c.getLifecycleEdges(conceptId, { direction: "out", family: "supersession" })).toEqual([]);
    expect(c.ruleBinding(conceptId)!.severity).toBe("blocking");
    expect(raw(c).prepare(`SELECT COUNT(*) AS n FROM concepts WHERE kind = 'rule'`).get()).toEqual({ n: 1 });
    c.close();
  });

  it("still leaves an ordinary correction on an ordinary concept alone", async () => {
    const c = core();
    const fact = await c.store("The service listens on port 8080.", { kind: "fact" });
    const correction = await c.store("It listens on 9090 now.", { kind: "correction", attachTo: fact.conceptId });
    expect(correction.conceptId).toBe(fact.conceptId);
    expect(correction.contradiction).toBeDefined();
    expect(correction.ruleSuccession).toBeUndefined();
    c.close();
  });
});

// ---------------------------------------------------------------------------
// provenance
// ---------------------------------------------------------------------------
describe("rule provenance", () => {
  const SPAN = formatSpan({ host: "claude-code", sessionId: "sess-1", anchor: "L10-L42" });

  it("turns a span:// sourceRef into a provenance edge and leaves ordinary refs alone", async () => {
    const c = core();
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule",
      sourceRefs: [SPAN, "src/deploy.ts"],
      rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    const provenance = c.getLifecycleEdges(rule.conceptId, { direction: "out", family: "provenance" });
    expect(provenance).toHaveLength(1);
    expect(provenance[0]).toMatchObject({ dst_span: SPAN, born_of: "correction", event_ref: rule.observationId });
    // The non-span ref stayed an ordinary ref — a file path is not a transcript location.
    expect(JSON.parse((raw(c).prepare(`SELECT source_refs FROM concepts WHERE id = ?`).get(rule.conceptId) as { source_refs: string }).source_refs))
      .toEqual([SPAN, "src/deploy.ts"]);
    c.close();
  });

  it("stores a rule with no span at all — span absence is a curation signal, not an error", async () => {
    const c = core();
    const rule = await c.store("A rule captured without a transcript pointer.", {
      kind: "rule", sourceRefs: ["src/deploy.ts"], rule: { stage: "git force push", ...AGENT_RULE },
    });
    expect(c.getLifecycleEdges(rule.conceptId, { direction: "out", family: "provenance" })).toEqual([]);
    c.close();
  });

  it("records the successor's span too, when a correction carries one", async () => {
    const c = core();
    const rule = await c.store("Never force-push.", { kind: "rule", rule: { stage: "git force push", ...AGENT_RULE } });
    const successor = await c.store("Never force-push to a SHARED branch.", {
      kind: "correction", attachTo: rule.conceptId, sourceRefs: [SPAN],
    });
    expect(c.getLifecycleEdges(successor.conceptId, { direction: "out", family: "provenance" })[0])
      .toMatchObject({ dst_span: SPAN });
    c.close();
  });
});

// ---------------------------------------------------------------------------
// declaration
// ---------------------------------------------------------------------------
describe("declaration — the sovereign entrance", () => {
  it("declares a stage, then a rule at it, and replaces patterns on re-declaration", async () => {
    const c = core();
    const stage = await c.declare({ species: "stage", stage: "terraform apply", patterns: ["terraform apply"] });
    expect(stage).toMatchObject({ species: "stage" });
    expect(c.stages()[0]).toMatchObject({ name: "terraform apply", origin: "declaration", verified: false });
    expect(c.stages()[0]!.patterns).toEqual([{ tool: null, tokens: ["terraform", "apply"] }]);

    // Re-declaration REPLACES: this is how a mis-seeded pattern is fixed.
    await c.declare({ species: "stage", stage: "terraform apply", patterns: ["Bash:terraform apply", "Bash:terraform destroy"] });
    expect(c.stages()).toHaveLength(1);
    expect(c.stages()[0]!.patterns).toEqual([
      { tool: "bash", tokens: ["terraform", "apply"] },
      { tool: "bash", tokens: ["terraform", "destroy"] },
    ]);

    const rule = await c.declare({
      species: "rule", stage: "terraform apply", content: "Always run plan first.",
      reason: "an unreviewed apply is unreviewable afterwards", declaredBy: "john", ...AGENT_RULE,
    });
    expect(rule.species).toBe("rule");
    if (rule.species !== "rule") throw new Error("unreachable");
    expect(rule.binding).toMatchObject({
      severity: "advisory", origin: "declaration", declared_by: "john",
      reason: "an unreviewed apply is unreviewable afterwards",
    });
    c.close();
  });

  it("is the ONLY surface that mints blocking severity", async () => {
    const c = core();
    const declared = await c.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a directory tree unattended.",
      severity: "blocking", reason: "there is no undo", declaredBy: "john", ...AGENT_RULE,
    });
    if (declared.species !== "rule") throw new Error("unreachable");
    expect(declared.binding.severity).toBe("blocking");
    // ...and the SCHEMA agrees, so a raw INSERT cannot mint it either.
    expect(() =>
      raw(c).prepare(
        `INSERT INTO rule_bindings (concept_id, stage_id, severity, scope, model_tag, origin, created_at, sync_updated_at)
         VALUES ('forged', 'anything', 'blocking', 'domain', NULL, 'correction', 1, 1)`,
      ).run(),
    ).toThrow(/CHECK constraint failed/);
    c.close();
  });

  it("replaces an existing binding on re-declaration — including downgrading a blocking rule", async () => {
    const c = resolvingCore();
    const first = await c.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a directory tree unattended.",
      severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (first.species !== "rule") throw new Error("unreachable");
    const again = await c.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a directory tree unattended.",
      severity: "advisory", reason: "downgraded on reflection", ...AGENT_RULE,
    });
    if (again.species !== "rule") throw new Error("unreachable");
    expect(again.conceptId).toBe(first.conceptId);
    expect(c.ruleBinding(first.conceptId)).toMatchObject({ severity: "advisory", reason: "downgraded on reflection" });
    c.close();
  });

  it("REFUSES a blocking declaration that states no reason — a deny has to be explainable", async () => {
    const c = core();
    // The boundary statement promises every deny arrives carrying the failure it prevents, and a
    // promise the write path does not enforce is not a promise. A deny the agent cannot explain is
    // the one people learn to route around: the gate fires, the refusal is bare, and the cheapest
    // response available is to rephrase the action until it stops matching.
    await expect(c.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a tree unattended.",
      severity: "blocking", ...AGENT_RULE,
    })).rejects.toThrow(/blocking rule requires `reason`/);

    // Whitespace is not a reason. Without the trim, the check is satisfied by the SHAPE of a value
    // rather than its content — which is the one bypass a required-field guard invites, and the
    // gate would render a blank line where the explanation belongs.
    await expect(c.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a tree unattended.",
      severity: "blocking", reason: "   ", ...AGENT_RULE,
    })).rejects.toThrow(/blocking rule requires `reason`/);

    // REFUSED MEANS NOTHING HAPPENED. The check sits with the rest of declare()'s validation, ahead
    // of every write, so a failed sovereign act leaves no concept, no binding and no stage behind.
    expect(raw(c).prepare(`SELECT COUNT(*) AS n FROM rule_bindings`).get()).toEqual({ n: 0 });
    expect(c.stages()).toEqual([]);

    // Advisory is deliberately untouched: an advisory with no reason is weaker guidance, not a
    // broken contract, so requiring one there would be a cost with nothing on the other side.
    const advisory = await c.declare({
      species: "rule", stage: "rm -rf", content: "Prefer a dry run before deleting.", ...AGENT_RULE,
    });
    if (advisory.species !== "rule") throw new Error("unreachable");
    expect(advisory.binding).toMatchObject({ severity: "advisory", reason: null });
    c.close();
  });

  it("REFUSES an advisory→blocking UPGRADE that states no reason, and leaves the advisory standing", async () => {
    const c = resolvingCore();
    // The upgrade is the case the guard exists for, and the one severity-preservation makes easy to
    // test wrong: an OMITTED severity preserves whatever the binding already has, so a declaration
    // that omits it never rules on severity and never reaches this check. This one names `blocking`
    // explicitly on a rule that is currently advisory — deny power actually being acquired.
    const first = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", ...AGENT_RULE,
    });
    if (first.species !== "rule") throw new Error("unreachable");
    expect(c.ruleBinding(first.conceptId)).toMatchObject({ severity: "advisory", reason: null });

    await expect(c.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a tree unattended.",
      severity: "blocking", ...AGENT_RULE,
    })).rejects.toThrow(/blocking rule requires `reason`/);
    // The incumbent is exactly as it was found — including its own (absent) reason, which the
    // refused declaration did not get to overwrite.
    expect(c.ruleBinding(first.conceptId)).toMatchObject({ severity: "advisory", reason: null });
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules[0]!.severity).toBe("advisory");

    // With the reason supplied the same upgrade goes through, and the gate delivers it alongside.
    const upgraded = await c.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a tree unattended.",
      severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (upgraded.species !== "rule") throw new Error("unreachable");
    expect(upgraded.conceptId).toBe(first.conceptId);
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules[0])
      .toMatchObject({ severity: "blocking", reason: "there is no undo" });
    c.close();
  });

  /**
   * A deny's reason is the second thing about it that an ordinary restatement must not silently
   * take away. The severity-preservation rule already says restating a rule's text or its gate is
   * not a ruling on its failure mode; these say the same about WHY it exists. Both halves live in
   * bindRule so the two read as siblings rather than one rule and one special case.
   */
  const DENY = { stage: "rm -rf", content: "Never delete a tree unattended." };

  it("PRESERVES an omitted reason exactly as it preserves an omitted severity", async () => {
    const c = resolvingCore();
    const deny = await c.declare({
      species: "rule", patterns: ["Bash:rm -rf"], ...DENY,
      severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");

    // THE ONBOARDING RE-SORT: the rule restated, with no ruling on severity and no ruling on the
    // reason. Both survive. The write this replaces preserved the severity and cleared the reason,
    // which left a live deny firing with nothing underneath it — the exact state the declaration
    // guard exists to prevent, reached through the path most likely to be walked.
    const again = await c.declare({ species: "rule", ...DENY, ...AGENT_RULE });
    if (again.species !== "rule") throw new Error("unreachable");
    expect(again.conceptId).toBe(deny.conceptId);
    expect(c.ruleBinding(deny.conceptId)).toMatchObject({ severity: "blocking", reason: "there is no undo" });
    // ...and the gate still DELIVERS it, which is the only form of survival that matters.
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules[0])
      .toMatchObject({ severity: "blocking", reason: "there is no undo" });

    // The same holds one severity down, where no guard is involved at all — preservation is a
    // property of the resolution, not a side effect of protecting deny power.
    const advisory = await c.declare({
      species: "rule", stage: "terraform apply", content: "Always run plan first.",
      reason: "a plan is the only review anyone gets", ...AGENT_RULE,
    });
    if (advisory.species !== "rule") throw new Error("unreachable");
    await c.declare({ species: "rule", stage: "terraform apply", content: "Always run plan first.", ...AGENT_RULE });
    expect(c.ruleBinding(advisory.conceptId)).toMatchObject({
      severity: "advisory", reason: "a plan is the only review anyone gets",
    });
    c.close();
  });

  it("carries a withdrawn deny's reason forward into the advisory it becomes", async () => {
    const c = core();
    const deny = await c.declare({
      species: "rule", patterns: ["Bash:rm -rf"], ...DENY,
      severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    // Withdrawing deny power is a ruling on severity and nothing else. The rule still exists, still
    // fires, and still exists for the reason it always did — so the withdrawal keeps it rather than
    // leaving advisory guidance that cannot say what it is for.
    await withdrawDeny(c, deny.conceptId, "rm -rf");
    expect(c.ruleBinding(deny.conceptId)).toMatchObject({ severity: "advisory", reason: "there is no undo" });
    c.close();
  });

  it("REFUSES a restatement that blanks a live deny's reason, though it never named a severity", async () => {
    const c = resolvingCore();
    const deny = await c.declare({
      species: "rule", patterns: ["Bash:rm -rf"], ...DENY,
      severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");

    // This is the case declare()'s guard structurally CANNOT catch. It runs before the embed, so it
    // does not know which concept the declaration will land on and cannot consult the incumbent; all
    // it can see is that the caller named no severity. Blocking is preserved by resolution, well
    // after that check has passed — so the blank arrives at a rule that is about to keep denying.
    for (const blank of ["", "   ", "\n\t "]) {
      await expect(
        c.declare({ species: "rule", ...DENY, reason: blank, ...AGENT_RULE }),
        `reason ${JSON.stringify(blank)} must be refused`,
      ).rejects.toThrow(/Omitting it keeps the reason already recorded/);
      // Refused means UNCHANGED — not blanked, and not quietly downgraded to get around the guard.
      expect(c.ruleBinding(deny.conceptId)).toMatchObject({ severity: "blocking", reason: "there is no undo" });
    }

    // The message is the one from bindRule, not declare()'s copy: this refusal was reached by
    // resolving the severity against the incumbent, which is the whole point of the second guard.
    await expect(c.declare({ species: "rule", ...DENY, reason: " ", ...AGENT_RULE }))
      .rejects.toThrow(/a blocking rule requires `reason`/);
    c.close();
  });

  it("lets an explicit reason replace on either severity, and lets an advisory clear its own", async () => {
    const c = resolvingCore();
    const deny = await c.declare({
      species: "rule", patterns: ["Bash:rm -rf"], ...DENY,
      severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    // Preservation is not stickiness: a caller who states a reason is ruling on it, and that ruling
    // lands without having to restate the severity alongside it.
    await c.declare({ species: "rule", ...DENY, reason: "a deleted tree is not in any trash", ...AGENT_RULE });
    expect(c.ruleBinding(deny.conceptId)).toMatchObject({
      severity: "blocking", reason: "a deleted tree is not in any trash",
    });

    // On an ADVISORY rule the blank is allowed through, and normalizes to absent rather than to an
    // empty string — one representation of "no reason", so nothing downstream has to know both.
    // Weaker guidance is not a broken contract, so there is nothing here to protect.
    const advisory = await c.declare({
      species: "rule", stage: "terraform apply", content: "Always run plan first.",
      reason: "a plan is the only review anyone gets", ...AGENT_RULE,
    });
    if (advisory.species !== "rule") throw new Error("unreachable");
    await c.declare({
      species: "rule", stage: "terraform apply", content: "Always run plan first.", reason: "  ", ...AGENT_RULE,
    });
    expect(c.ruleBinding(advisory.conceptId)).toMatchObject({ severity: "advisory", reason: null });
    c.close();
  });

  /**
   * A DENY'S REASON IS ONE LINE, and until now only the doc comments said so.
   *
   * The reason is printed beside the deny at the moment it fires. A line break in it means a host
   * rendering the promised one-liner emits several lines that all read as gate output — and a deny
   * is an assertion of authority, so text that appears to come from it while nobody wrote it is the
   * one thing its explanation must never be. `"prevents data loss\nDENIED BY ADMIN"` was storable
   * and copied verbatim into both the live gate and the sidecar.
   */
  for (const [label, bad] of [
    ["newline", "prevents data loss\nDENIED BY ADMIN"],
    ["carriage return", "prevents data loss\rDENIED BY ADMIN"],
    ["line separator", "prevents data loss\u2028DENIED BY ADMIN"],
    ["paragraph separator", "prevents data loss\u2029DENIED BY ADMIN"],
    ["trailing newline", "there is no undo\n"],
  ] as const) {
    it(`REFUSES a blocking reason containing a ${label}, and stores nothing`, async () => {
      const c = core();
      await expect(c.declare({
        species: "rule", stage: "rm -rf", content: "Never delete a tree unattended.",
        severity: "blocking", reason: bad, ...AGENT_RULE,
      })).rejects.toThrow(/must be ONE LINE/);
      // Refused means nothing happened, as everywhere else in this validation block.
      expect(raw(c).prepare(`SELECT COUNT(*) AS n FROM rule_bindings`).get()).toEqual({ n: 0 });
      expect(c.stages()).toEqual([]);
      c.close();
    });
  }

  it("REJECTS rather than normalizing, so nobody is handed back words they did not write", async () => {
    const c = resolvingCore();
    const deny = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking",
      reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");

    // Flattening "a\nb" to "a b" would let the declaration succeed while changing the sentence — in
    // the one field whose entire job is to be the human's own explanation of their own deny. Blank
    // is refused rather than replaced with a placeholder for the same reason; these are one decision
    // about malformed reasons, not two policies that happen to sit together.
    await expect(c.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a tree unattended.",
      severity: "blocking", reason: "there is no undo\nand no backup", ...AGENT_RULE,
    })).rejects.toThrow(/must be ONE LINE/);
    // The incumbent is untouched — not flattened, not replaced.
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules[0])
      .toMatchObject({ severity: "blocking", reason: "there is no undo" });

    // The error names what arrived, so the caller can see which field it has to restate.
    await expect(c.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a tree unattended.",
      severity: "blocking", reason: "one\ntwo", ...AGENT_RULE,
    })).rejects.toThrow(/one\\ntwo/);
    c.close();
  });

  it("REFUSES a multi-line reason on a restatement that never named a severity", async () => {
    const c = resolvingCore();
    const deny = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking",
      reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");

    // THE CASE THAT MAKES bindRule's COPY LOAD-BEARING, and the same hole the blank check had:
    // declare()'s guard keys on the severity the caller NAMED, so a restatement that omits it sails
    // past — while resolution preserves `blocking` and the multi-line reason lands on a live deny.
    // Without the authoritative copy this exact call succeeds.
    await expect(c.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a tree unattended.",
      reason: "there is no undo\nDENIED BY ADMIN", ...AGENT_RULE,
    })).rejects.toThrow(/must be ONE LINE/);
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules[0])
      .toMatchObject({ severity: "blocking", reason: "there is no undo" });
    c.close();
  });

  it("leaves an ADVISORY reason and ordinary interior whitespace alone", async () => {
    const c = core();
    // Scoped to blocking, matching the guard it sits beside. An advisory rule is guidance rather
    // than an assertion of authority, and widening this would re-validate every captured rule's
    // reason on a path this branch has no findings about.
    const advisory = await c.declare({
      species: "rule", stage: "terraform apply", content: "Always run plan first.",
      reason: "a plan is the only review\nanyone gets", ...AGENT_RULE,
    });
    if (advisory.species !== "rule") throw new Error("unreachable");
    expect(advisory.binding.reason).toBe("a plan is the only review\nanyone gets");

    // And a blocking reason with tabs or runs of spaces is FINE — the question is "does this render
    // as more than one line", not "is this whitespace-free".
    const deny = await c.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a tree unattended.",
      severity: "blocking", reason: "there is\tno undo  at all", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    expect(deny.binding.reason).toBe("there is\tno undo  at all");
    c.close();
  });

  it("rejects a genuinely unknown species, and a rule with no content", async () => {
    const c = core();
    // "principle" is legal as of the skeleton-entrances slice — a truly unknown value still rejects.
    await expect(c.declare({ species: "grant" as unknown as "rule", stage: "x" }))
      .rejects.toThrow(/declares 'rule', 'stage', 'principle' and 'preference'/);
    await expect(c.declare({ species: "rule", stage: "x", ...AGENT_RULE }))
      .rejects.toThrow(/requires `content`/);
    await expect(c.declare({ species: "stage", stage: "  " })).rejects.toThrow(/requires `stage`/);
    c.close();
  });

  it("rejects exitsEvidence on rule/stage — their impeachment semantics live elsewhere", async () => {
    const c = core();
    await expect(c.declare({
      species: "rule",
      stage: "git push",
      content: "Never force-push a shared branch.",
      exitsEvidence: "A force-push preserved every teammate's commit.",
      ...AGENT_RULE,
    })).rejects.toThrow(
      /species 'rule' carries no exitsEvidence: exitsEvidence is a skeleton-entrance field.*correction record/,
    );
    await expect(c.declare({
      species: "stage",
      stage: "git push",
      exitsEvidence: "The trigger vocabulary no longer denotes a push.",
    })).rejects.toThrow(
      /species 'stage' carries no exitsEvidence: exitsEvidence is a skeleton-entrance field.*trigger vocabulary/,
    );
    c.close();
  });

  // -------------------------------------------------------------------------
  // skeleton entrances (5-A): declare() species "principle"/"preference"
  // -------------------------------------------------------------------------
  describe("declaration entrance into the skeleton — species principle/preference", () => {
    it("declares a principle: momentless, no stage/severity/patterns, live in the skeleton immediately", async () => {
      const c = core();
      const r = await c.declare({
        species: "principle",
        content: "A build/install artifact is a snapshot or a live link — know which you hold.",
        declaredBy: "john",
      });
      if (r.species !== "principle") throw new Error("unreachable");
      expect(r.action).toBe("created");
      expect(r.conceptId).toBeTruthy();
      expect(Array.isArray(r.advisories)).toBe(true);
      // Delivery is read from the standing skeleton surface, not repeated in the write acknowledgement.
      const own = c.skeleton().find((e) => e.conceptId === r.conceptId);
      expect(own).toMatchObject({ species: "principle", ratifiedBy: "john" });
      // firstLine() strips the trailing sentence-ending period (title-extraction convention, same
      // helper memory_fetch/overview titles already use) — content is the sentence, not the mark.
      expect(own!.content).toBe("A build/install artifact is a snapshot or a live link — know which you hold");
      c.close();
    });

    it("declares a preference the identical way — momentless, live immediately", async () => {
      const c = core();
      const r = await c.declare({ species: "preference", content: "Write as a peer, never assistant scaffolding." });
      if (r.species !== "preference") throw new Error("unreachable");
      expect(c.skeleton().some((e) => e.conceptId === r.conceptId && e.species === "preference")).toBe(true);
      c.close();
    });

    it("defaults declaredBy/ratifiedBy to the agent id when omitted", async () => {
      const c = core();
      const r = await c.declare({ species: "principle", content: "Nothing waits on scheduled review; everything is maintained by use." });
      if (r.species !== "principle") throw new Error("unreachable");
      const own = c.skeleton().find((e) => e.conceptId === r.conceptId)!;
      expect(own.ratifiedBy).toBe("local-agent"); // MonetCore's default agentId when unconfigured
      c.close();
    });

    it("rejects stage/severity/patterns on species principle/preference — a preference bound to a moment is just a rule", async () => {
      const c = core();
      await expect(c.declare({ species: "principle", content: "x", stage: "git push" }))
        .rejects.toThrow(/momentless and cannot bind to a stage.*use species:"rule"/);
      await expect(c.declare({ species: "preference", content: "x", severity: "advisory" }))
        .rejects.toThrow(/carries no severity.*use species:"rule"/);
      await expect(c.declare({ species: "principle", content: "x", patterns: ["git push"] }))
        .rejects.toThrow(/carries no trigger patterns.*use species:"rule"/);
      c.close();
    });

    it.each(["principle", "preference"] as const)(
      "rejects rule-binding fields on species %s — momentless declarations cannot discard them",
      async (species) => {
        const c = core();
        await expect(c.declare({ species, content: "x", scope: "domain" }))
          .rejects.toThrow(new RegExp(`species '${species}' carries no scope: scope is a rule-binding property.*use species:"rule"`));
        await expect(c.declare({ species, content: "x", modelTag: "model-1" }))
          .rejects.toThrow(new RegExp(`species '${species}' carries no modelTag: modelTag names the model a rule.*use species:"rule"`));
        await expect(c.declare({ species, content: "x", reason: "there is no undo" }))
          .rejects.toThrow(new RegExp(`species '${species}' carries no reason: reason explains a rule.*use species:"rule"`));
        await expect(c.declare({ species, content: "x", acknowledgeBlockingRules: ["rule-1"] }))
          .rejects.toThrow(
            new RegExp(`species '${species}' carries no blocking-rule acknowledgement: acknowledgeBlockingRules.*use species:"rule"`),
          );
        c.close();
      },
    );

    it("requires content for principle/preference", async () => {
      const c = core();
      await expect(c.declare({ species: "principle" })).rejects.toThrow(/declaring a principle requires `content`/);
      await expect(c.declare({ species: "preference", content: "   " }))
        .rejects.toThrow(/declaring a preference requires `content`/);
      c.close();
    });

    it('accepts circle:"*" for principle/preference, keeps an ordinary home, and refuses it for stage', async () => {
      const c = core({ circle: "home" });
      const principle = await c.declare({
        species: "principle", content: "A global principle.", circle: BREADTH_CIRCLE,
      });
      const preference = await c.declare({
        species: "preference", content: "A global preference.", circle: BREADTH_CIRCLE,
      });
      if (principle.species !== "principle" || preference.species !== "preference") {
        throw new Error("unreachable");
      }

      expect(raw(c).prepare(`SELECT circle, skeleton_breadth FROM concepts WHERE id = ?`).get(principle.conceptId))
        .toEqual({ circle: "home", skeleton_breadth: "global" });
      expect(raw(c).prepare(`SELECT circle, skeleton_breadth FROM concepts WHERE id = ?`).get(preference.conceptId))
        .toEqual({ circle: "home", skeleton_breadth: "global" });
      expect(c.skeleton().find((entry) => entry.conceptId === principle.conceptId)?.breadth).toBe("global");
      expect(c.skeleton().find((entry) => entry.conceptId === preference.conceptId)?.breadth).toBe("global");
      expect(c.skeleton().map((entry) => entry.conceptId).sort())
        .toEqual([principle.conceptId, preference.conceptId].sort());

      await expect(c.declare({ species: "stage", stage: "git push", circle: BREADTH_CIRCLE }))
        .rejects.toThrow(/cannot apply to a stage declaration.*already store-global/);
      c.close();
    });

    /**
     * THE MISFILING BLOCKER (review round 1, item 1), at SHIPPING thresholds — `core()` above
     * disables dedup (tauAttach 1.1), which is exactly why this class was invisible until a
     * runtime reproduction. Resolution is kind-blind, so before the fork guard an incoming
     * principle auto-attached to any governable concept above tauAttach and the declaration
     * entrance then stamped "approve" onto that foreign row.
     */
    describe("cross-kind misfiling, at real dedup thresholds", () => {
      it("FORKS off a similar existing FACT rather than attaching to it, and ratifies the new row", async () => {
        const c = resolvingCore();
        const text = "Verify a prior step's success before depending on it.";
        const fact = await c.store(text); // an ordinary fact, same wording
        const declared = await c.declare({ species: "principle", content: text });
        if (declared.species !== "principle") throw new Error("unreachable");

        // FORKED, not attached — the fact is untouched and a real principle now exists.
        expect(declared.conceptId).not.toBe(fact.conceptId);
        expect(declared.action).toBe("created");
        expect(raw(c).prepare(`SELECT kind FROM concepts WHERE id = ?`).get(declared.conceptId))
          .toMatchObject({ kind: "principle" });
        expect(raw(c).prepare(`SELECT kind FROM concepts WHERE id = ?`).get(fact.conceptId))
          .toMatchObject({ kind: "fact" });

        // The ratification landed on the PRINCIPLE, never on the fact...
        expect(c.getRatifications(declared.conceptId)).toHaveLength(1);
        expect(c.getRatifications(fact.conceptId)).toHaveLength(0);
        // ...and the skeleton actually delivers it, which is what the misfile silently prevented.
        expect(c.skeleton().some((e) => e.conceptId === declared.conceptId)).toBe(true);
        // The near-match is still reported rather than swallowed by the fork.
        expect(declared.advisories).toContainEqual(
          expect.objectContaining({ kind: "near_match", conceptId: fact.conceptId }),
        );
        c.close();
      });

      it("records the safety fork as species-fork in the store packet, event, and overview stats", async () => {
        const c = new MonetCore(":memory:", {});
        const text = "Verify a prior step's success before depending on it.";
        const fact = await c.store(text);
        const forked = await c.store(text, { kind: "principle" });

        expect(forked).toMatchObject({
          action: "created",
          resolutionMode: "species-fork",
          nearMatchId: fact.conceptId,
        });
        expect(raw(c).prepare(
          `SELECT action, mode FROM resolution_events WHERE observation_id = ?`,
        ).get(forked.observationId)).toEqual({ action: "created", mode: "species-fork" });

        const resolutionStats = c.resolutionStats("default");
        const resolutionCounts = Object.fromEntries(
          resolutionStats.byMode.map(({ mode, count }) => [mode, count]),
        );
        expect(resolutionCounts).toEqual({ "species-fork": 1, new: 1 });
        expect(resolutionStats.decidedTotal).toBe(2);
        expect(resolutionCounts).not.toHaveProperty("attach");
        expect(resolutionCounts).not.toHaveProperty("fork-signal");
        c.close();
      });

      it("ATTACHES when re-declaring the SAME principle — one concept, idempotent membership", async () => {
        const c = resolvingCore();
        const text = "A build/install artifact is a snapshot or a live link — know which you hold.";
        const first = await c.declare({ species: "principle", content: text });
        const second = await c.declare({ species: "principle", content: text });
        if (first.species !== "principle" || second.species !== "principle") throw new Error("unreachable");

        // SAME species resolves together — the correct semantics, and why this is a cross-kind
        // guard rather than a blanket forceNew.
        expect(second.conceptId).toBe(first.conceptId);
        expect(second.action).toBe("attached");
        // Two approves on one concept: membership is idempotent, not doubled.
        expect(c.getRatifications(first.conceptId)).toHaveLength(2);
        expect(c.skeleton().filter((e) => e.conceptId === first.conceptId)).toHaveLength(1);
        c.close();
      });

      it("re-declaration marks an existing member global without replacing ratification history", async () => {
        const c = resolvingCore();
        const content = "A build artifact is a snapshot; re-materialize after its source changes.";
        const local = await c.declare({ species: "principle", content, declaredBy: "first" });
        if (local.species !== "principle") throw new Error("unreachable");
        const historyBefore = c.getRatifications(local.conceptId).map((row) => ({
          id: row.id, verdict: row.verdict, packet: row.packet, ratifiedBy: row.ratified_by,
          createdAt: row.created_at,
        }));

        const migrated = await c.declare({
          species: "principle", content, circle: BREADTH_CIRCLE, declaredBy: "migration",
        });
        if (migrated.species !== "principle") throw new Error("unreachable");
        expect(migrated.conceptId).toBe(local.conceptId);
        expect(migrated.action).toBe("attached");
        expect(c.skeleton("a-different-circle").find((entry) => entry.conceptId === local.conceptId)?.breadth)
          .toBe("global");

        const historyAfter = c.getRatifications(local.conceptId);
        expect(historyAfter).toHaveLength(2);
        expect(historyAfter.map((row) => ({
          id: row.id, verdict: row.verdict, packet: row.packet, ratifiedBy: row.ratified_by,
          createdAt: row.created_at,
        }))).toContainEqual(historyBefore[0]);
        c.close();
      });

      it("FORKS off a live BLOCKING RULE, leaving the rule and its deny completely untouched", async () => {
        const c = resolvingCore();
        const text = "Never delete a directory tree unattended.";
        const deny = await c.declare({
          species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
          content: text, severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
        });
        if (deny.species !== "rule") throw new Error("unreachable");

        const declared = await c.declare({ species: "principle", content: text });
        if (declared.species !== "principle") throw new Error("unreachable");
        expect(declared.conceptId).not.toBe(deny.conceptId);

        // NO FOREIGN RATIFICATION on the rule, and the deny still fires exactly as before.
        expect(c.getRatifications(deny.conceptId)).toHaveLength(0);
        expect(raw(c).prepare(`SELECT kind FROM concepts WHERE id = ?`).get(deny.conceptId))
          .toMatchObject({ kind: "rule" });
        expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules[0])
          .toMatchObject({ severity: "blocking", reason: "there is no undo" });
        c.close();
      });

      it("refuses an explicitly NAMED cross-kind target too — the other door into the same misfile", async () => {
        const c = core();
        const fact = await c.store("An ordinary fact.");
        await expect(c.store("A principle aimed at a fact.", { kind: "principle", attachTo: fact.conceptId }))
          .rejects.toThrow(/cannot attach principle evidence to concept .*: it is a 'fact', not a principle/);
        expect(c.getRatifications(fact.conceptId)).toHaveLength(0);
        c.close();
      });
    });

    it("writes the concept and its ratification ATOMICALLY — no concept without its skeleton entry", async () => {
      // Review round 1, item 6. The sibling precedent is the RULE branch, which composes
      // store() + binding inside store()'s own transaction; the principle branch now rides the
      // same seam. Proved by making the ratification write fail (a poisoned `ratifications` table)
      // and observing that the CONCEPT did not survive either.
      const c = core();
      raw(c).prepare(`DROP TABLE ratifications`).run();
      await expect(c.declare({ species: "principle", content: "A principle whose entry cannot be written." }))
        .rejects.toThrow();
      // THE WHOLE ACT ROLLED BACK: no orphan principle concept, which is what a non-atomic
      // sequence would have left behind — invisible to skeleton(), un-retirable via memory_ratify.
      expect(raw(c).prepare(`SELECT COUNT(*) AS n FROM concepts WHERE kind = 'principle'`).get())
        .toMatchObject({ n: 0 });
      expect(raw(c).prepare(`SELECT COUNT(*) AS n FROM observations`).get()).toMatchObject({ n: 0 });
      c.close();
    });

    it("surfaces the skeleton in the rendered curation view, not only in JSON", async () => {
      // Review round 1, item 5: renderOverview is the human curation surface (it is what the CLI
      // prints), so contract 7 is not discharged by a JSON field alone.
      const c = core();
      await c.declare({ species: "principle", content: "Encode principles, not procedures.", declaredBy: "john" });
      await c.declare({ species: "preference", content: "Write as a peer, never assistant scaffolding." });

      // SCOPED TO THE SECTION, not the whole render: a retired principle is still an ordinary
      // concept and legitimately keeps appearing in LIVING MODEL — what must change is its
      // SKELETON membership, so asserting against the whole string would test the wrong thing.
      const skeletonSection = (out: string): string =>
        out.split("\n").reduce<{ lines: string[]; inside: boolean }>((acc, line) => {
          if (line.startsWith("SKELETON")) return { lines: [line], inside: true };
          if (acc.inside && line.trim() === "") return { ...acc, inside: false };
          return acc.inside ? { lines: [...acc.lines, line], inside: true } : acc;
        }, { lines: [], inside: false }).lines.join("\n");

      const ov = c.overview("default");
      expect(ov.counts.skeleton).toBe(2);
      const before = skeletonSection(renderOverview(ov, { color: false }));
      expect(before).toContain("SKELETON");
      expect(before).toContain("Encode principles, not procedures");
      expect(before).toContain("Write as a peer, never assistant scaffolding");
      expect(before).toContain("john");

      // Retiring one drops it from the rendered section, since membership is derived, not a flag.
      const retired = ov.skeleton.find((e) => e.species === "preference")!;
      await c.ratify({ candidateId: retired.conceptId, verdict: "retire" });
      const after = skeletonSection(renderOverview(c.overview("default"), { color: false }));
      expect(after).toContain("Encode principles, not procedures");
      expect(after).not.toContain("Write as a peer, never assistant scaffolding");
      c.close();
    });

    describe("warning-light advisories — mechanical only, NEVER block the write", () => {
      it('advises when content matches an EXISTING stage\'s own trigger patterns, naming the stage', async () => {
        const c = core();
        await c.declare({ species: "stage", stage: "terraform apply", patterns: ["terraform apply"] });
        const r = await c.declare({
          species: "principle",
          content: "Always run terraform apply only after a clean plan.",
        });
        if (r.species !== "principle") throw new Error("unreachable");
        // NEVER BLOCKS: the write proceeded despite looking rule-shaped.
        expect(r.conceptId).toBeTruthy();
        expect(r.advisories).toContainEqual(
          expect.objectContaining({ kind: "stage_shaped", stage: "terraform apply" }),
        );
        c.close();
      });

      it("advises on command-shaped content (Tool:command convention) when no stage matches", async () => {
        const c = core();
        const r = await c.declare({
          species: "preference",
          // Deliberately shaped like the gate's own Tool:command convention (parseActionContext's
          // `tool` field) to trigger the mechanical, no-new-machinery detection — not realistic
          // principle prose, but exactly what the advisory exists to catch.
          content: "Bash:always confirm before an irreversible delete",
        });
        if (r.species !== "preference") throw new Error("unreachable");
        expect(r.advisories).toContainEqual(expect.objectContaining({ kind: "stage_shaped" }));
        expect(r.advisories.find((a) => a.kind === "stage_shaped")!.stage).toBeUndefined();
        c.close();
      });

      it("advises when exitsEvidence is absent, and not when it is given", async () => {
        const c = core();
        const withoutEvidence = await c.declare({ species: "principle", content: "Encode principles, not procedures." });
        if (withoutEvidence.species !== "principle") throw new Error("unreachable");
        expect(withoutEvidence.advisories).toContainEqual(expect.objectContaining({ kind: "missing_exits_evidence" }));

        const withEvidence = await c.declare({
          species: "principle",
          content: "Write user-facing consequences before escalating a decision.",
          exitsEvidence: "A decision escalated with no stated consequence, or a consequence that never happened.",
        });
        if (withEvidence.species !== "principle") throw new Error("unreachable");
        expect(withEvidence.advisories.some((a) => a.kind === "missing_exits_evidence")).toBe(false);
        c.close();
      });

      it("surfaces store()'s own near-match info when a declaration lands in the AMBIGUOUS band (fork, not attach)", async () => {
        // A plain clean attach (score above tauAttach) does NOT set nearMatchId — verified against
        // this engine directly: nearMatchId/nearMatchScore are only populated on the AMBIGUOUS
        // pairing modes (ambiguous-fork/fork-signal/blur-duplicate), where resolution found a
        // near neighbour but did NOT attach to it. A deterministic fixed-vector embedder (real
        // HashingEmbeddingProvider similarity between two DIFFERENT sentences is not something a
        // test can hand-pick a score for) puts the second write exactly in that band.
        const theta = Math.acos(0.7);
        const embedder = {
          dim: 2,
          modelId: "test-fixed-vectors",
          embed: (text: string): Float32Array => {
            if (text === "first") return new Float32Array([1, 0]);
            if (text === "second") return new Float32Array([Math.cos(theta), Math.sin(theta)]);
            throw new Error(`no fixed vector for ${JSON.stringify(text)}`);
          },
        };
        const c = new MonetCore(":memory:", { embedder, tauAttach: 0.9, tauAmbiguous: 0.5 });
        const first = await c.declare({ species: "principle", content: "first" });
        if (first.species !== "principle") throw new Error("unreachable");
        const second = await c.declare({ species: "principle", content: "second" });
        if (second.species !== "principle") throw new Error("unreachable");
        // Ambiguous band forks — two DIFFERENT concepts, not an attach.
        expect(second.conceptId).not.toBe(first.conceptId);
        expect(second.advisories).toContainEqual(
          expect.objectContaining({ kind: "near_match", conceptId: first.conceptId, score: 0.699999988079071 }),
        );
        c.close();
      });

      it("does NOT advise near-match for an ordinary clean attach — only the ambiguous band is noteworthy", async () => {
        const c = resolvingCore();
        const first = await c.declare({ species: "principle", content: "Verify a prior step's success before depending on it." });
        if (first.species !== "principle") throw new Error("unreachable");
        const second = await c.declare({ species: "principle", content: "Verify a prior step's success before depending on it." });
        if (second.species !== "principle") throw new Error("unreachable");
        // Identical wording resolves onto the SAME concept — a routine attach, not a fork.
        expect(second.conceptId).toBe(first.conceptId);
        expect(second.advisories.some((a) => a.kind === "near_match" || a.kind === "resolution")).toBe(false);
        c.close();
      });

      it("never blocks the write even when multiple advisories fire at once", async () => {
        const c = core();
        await c.declare({ species: "stage", stage: "terraform apply", patterns: ["terraform apply"] });
        // Stage-shaped (matches the "terraform apply" stage) AND missing-exits-evidence (none
        // given) both fire on this one write, and it still proceeds — advisories never block.
        const r = await c.declare({ species: "principle", content: "Always run terraform apply only after a clean plan." });
        if (r.species !== "principle") throw new Error("unreachable");
        expect(r.conceptId).toBeTruthy();
        expect(r.advisories.length).toBeGreaterThanOrEqual(2);
        expect(r.advisories.map((a) => a.kind).sort()).toEqual(["missing_exits_evidence", "stage_shaped"]);
        c.close();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// slice 5-B — the skeleton's use-maintenance loop
// ---------------------------------------------------------------------------
/**
 * "Nothing waits on scheduled review; everything is maintained by use." 5-A built the entrances
 * into the skeleton; this is the loop that keeps it honest afterwards, and every part of it rides
 * an event that was happening anyway:
 *
 *   D1  a correction kills a rule → doubt travels the parent edge → the principle drops out
 *   D2  a rule is born by projection → a derivation edge, and provenance at every later fire
 *   D3  a rule is born near another rule at ANOTHER stage → an extraction candidate is flagged
 *   D5  a projected rule fires while its parent is under impeachment → it says so
 *
 * The store-time thresholds matter here and differ per block: `core()` disables dedup so each
 * write yields its own concept (what D1/D2/D5 want — they are about edges, not resolution), while
 * the D3 block needs the AMBIGUOUS BAND, because the extraction flag rides the near-match a fork
 * produces. `bandCore` below is the same shape overview-possible-duplicates.test.ts already uses.
 */
describe("5-B: impeachment propagation — doubt travels the parent edge", () => {
  /** A ratified principle, live in the skeleton, ready to be a parent. */
  const principleOf = async (c: MonetCore, content: string): Promise<string> => {
    const r = await c.declare({ species: "principle", content, declaredBy: "john" });
    if (r.species !== "principle") throw new Error("unreachable");
    return r.conceptId;
  };

  const openImpeachments = (c: MonetCore, conceptId: string): Array<{ id: string; detail: string; status: string; resolved_by: string | null }> =>
    raw(c).prepare(
      `SELECT id, detail, status, resolved_by FROM contradictions WHERE concept_id = ? AND kind = 'impeachment' ORDER BY detected_at`,
    ).all(conceptId) as Array<{ id: string; detail: string; status: string; resolved_by: string | null }>;

  /**
   * FORCE "ACTIVE WITH AN OPEN CONTRADICTION" — a state no local call reaches today, and the raw
   * fixture is the honest way to say so. Every route back to `active` closes the open set first:
   * `resolveContradiction` recomputes the projection from what is still open, and `retireConcept`
   * dismisses every open row before retiring (so the retire/restore round-trip cannot leave one
   * standing either). The guards under test — the impeachment probe's `status = 'open'` clause and
   * `closeImpeachments`' approve/re-ratify branch — are therefore belt-and-braces against a state
   * only a graft or a future status path could produce. They are tested rather than dropped for the
   * same reason `resolveContradiction`'s own zero-live-observations postcondition exists: making the
   * state unreachable is better than resting on an argument that it currently is.
   */
  const forceActiveWithOpenContradiction = (c: MonetCore, conceptId: string): void => {
    raw(c).prepare(`UPDATE concepts SET status = 'active' WHERE id = ?`).run(conceptId);
  };

  it("a correction that kills a rule marks its parent principle disputed, with the impeaching evidence named", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation.");
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    // The parent edge, written the way memory_ratify writes it: the human named this rule as a
    // member of the principle's evidence.
    await c.ratify({ candidateId: principle, verdict: "re-ratify", memberRuleIds: [rule.conceptId], ratifiedBy: "john" });
    expect(c.skeleton("default").map((e) => e.conceptId)).toContain(principle);

    const correction = await c.store("Force-push is fine on your own branch; never on a shared one.", {
      kind: "correction", attachTo: rule.conceptId,
    });

    // DISCLOSED on the write that caused it — not discovered later by a sweep.
    expect(correction.ruleSuccession!.impeachedPrincipleIds).toEqual([principle]);

    // THE STRUCTURAL HALF: disputed, and therefore out of the skeleton at the very next read.
    expect((await c.getConcept(principle))!.status).toBe("disputed");
    expect(c.skeleton("default").map((e) => e.conceptId)).not.toContain(principle);

    // THE EVIDENCE HALF: the detail names all three things a human needs to re-rule — which rule
    // died (id AND its first line, so the record reads without a second fetch), what replaced it,
    // and the correction observation that did it.
    const [contra] = openImpeachments(c, principle);
    expect(contra!.status).toBe("open");
    expect(contra!.detail).toContain(`superseded rule '${rule.conceptId}'`);
    expect(contra!.detail).toContain("Never force-push to a shared branch");
    expect(contra!.detail).toContain(`successor rule '${correction.conceptId}'`);
    expect(contra!.detail).toContain(`correction observation '${correction.observationId}'`);
    c.close();
  });

  it("a raw correction-born supersession opens one impeachment and stays idempotent without an eventRef", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation.");
    const incumbent = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    const successor = await c.store("Force-push is fine on your own branch; never on a shared one.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force-with-lease", ...AGENT_RULE },
    });
    await c.ratify({
      candidateId: principle, verdict: "re-ratify", memberRuleIds: [incumbent.conceptId], ratifiedBy: "john",
    });

    const edge = c.addLifecycleEdge({
      family: "supersession", srcConceptId: incumbent.conceptId, dstConceptId: successor.conceptId,
      bornOf: "correction",
    });
    expect((await c.getConcept(principle))!.status).toBe("disputed");
    expect(c.skeleton("default").map((entry) => entry.conceptId)).not.toContain(principle);
    const [impeachment] = openImpeachments(c, principle);
    expect(impeachment!.detail).toContain(`supersession edge '${edge.id}' (no event_ref supplied)`);

    expect(() => c.addLifecycleEdge({
      family: "supersession", srcConceptId: incumbent.conceptId, dstConceptId: successor.conceptId,
      bornOf: "correction",
    })).toThrow(/is already superseded/);
    expect(openImpeachments(c, principle)).toHaveLength(1);
    c.close();
  });

  it("refuses fact-to-fact supersession before it can impeach a governing principle", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation.");
    const incumbent = await c.store("The current release points at image A.");
    const successor = await c.store("The current release points at image B.");
    c.addLifecycleEdge({
      family: "derivation", srcConceptId: principle, dstConceptId: incumbent.conceptId, bornOf: "extraction",
    });

    expect(() => c.addLifecycleEdge({
      family: "supersession", srcConceptId: incumbent.conceptId, dstConceptId: successor.conceptId,
      bornOf: "correction",
    })).toThrow(/supersession requires rule → rule endpoints: source .* has kind 'fact', destination .* has kind 'fact'/);
    expect(c.getLifecycleEdges(incumbent.conceptId, { direction: "out", family: "supersession" })).toEqual([]);
    expect(openImpeachments(c, principle)).toEqual([]);
    expect((await c.getConcept(principle))!.status).toBe("active");
    expect(c.skeleton("default").map((entry) => entry.conceptId)).toContain(principle);
    c.close();
  });

  it("a raw supersession eventRef uses the correction-observation needle shared with store replay", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation.");
    const incumbent = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    const successor = await c.store("Force-push is fine on your own branch; never on a shared one.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force-with-lease", ...AGENT_RULE },
    });
    c.addLifecycleEdge({
      family: "derivation", srcConceptId: principle, dstConceptId: incumbent.conceptId, bornOf: "extraction",
    });

    c.addLifecycleEdge({
      family: "supersession", srcConceptId: incumbent.conceptId, dstConceptId: successor.conceptId,
      bornOf: "correction", eventRef: successor.observationId,
    });
    const detail = openImpeachments(c, principle)[0]!.detail;
    expect(detail).toContain(`correction observation '${successor.observationId}'`);
    // The store replay path reconstructs from this exact shared substring.
    expect((raw(c).prepare(
      `SELECT COUNT(*) AS n FROM contradictions WHERE kind = 'impeachment' AND instr(detail, ?) > 0`,
    ).get(`correction observation '${successor.observationId}'`) as { n: number }).n).toBe(1);
    c.close();
  });

  /**
   * CITE ONLY WHAT IS PROVEN (review fix — PR #112 round 4). The substrate accepts any string as
   * eventRef, and the impeachment detail is now audit evidence memory_fetch exposes — so a bogus
   * ref, or a real observation belonging to some OTHER concept, must not be rendered as a
   * correction observation that never corrected anything. Unproven refs fall back to the honest
   * supersession-edge wording.
   */
  it("does NOT cite an unproven raw eventRef as a correction observation — edge wording instead", async () => {
    const c = core();
    const scenarios = [
      { name: "bogus ref", ref: () => "not-an-observation-id" },
      // A real observation that belongs to the PRINCIPLE, not the successor rule.
      { name: "foreign observation", ref: (ids: { principleObs: string }) => ids.principleObs },
    ] as const;
    for (const scenario of scenarios) {
      const principle = await principleOf(c, `Irreversible acts get a confirmation (${scenario.name}).`);
      const principleObs = (raw(c).prepare(
        `SELECT id FROM observations WHERE concept_id = ? LIMIT 1`,
      ).get(principle) as { id: string }).id;
      const incumbent = await c.store(`Never force-push to a shared branch (${scenario.name}).`, {
        kind: "rule", rule: { stage: `raw guard ${scenario.name}`, instance: `Bash:${scenario.name}`, ...AGENT_RULE },
      });
      const successor = await c.store(`Lease-push instead on shared branches (${scenario.name}).`, {
        kind: "rule", rule: { stage: `raw guard ${scenario.name}`, instance: `Bash:s-${scenario.name}`, ...AGENT_RULE },
      });
      c.addLifecycleEdge({ family: "derivation", srcConceptId: principle, dstConceptId: incumbent.conceptId, bornOf: "extraction" });
      c.addLifecycleEdge({
        family: "supersession", srcConceptId: incumbent.conceptId, dstConceptId: successor.conceptId,
        bornOf: "correction", eventRef: scenario.ref({ principleObs }),
      });
      const detail = openImpeachments(c, principle)[0]!.detail;
      expect(detail).not.toContain("correction observation");
      expect(detail).toContain("supersession edge");
    }
    c.close();
  });

  /**
   * A LIVE SUCCESSOR, OR NO SUCCESSION (review fix — PR #112 round 5). The store path's successor
   * is freshly created and always active; the raw writer could nominate a retired or disputed rule,
   * removing the incumbent from delivery (and impeaching its parent) for a replacement that cannot
   * fire. Refused, whole write rolled back: no edge, no impeachment, parent untouched.
   */
  it("refuses a raw supersession whose successor cannot fire — retired and disputed alike", async () => {
    const c = core();
    for (const shape of ["retired", "disputed"] as const) {
      const principle = await principleOf(c, `Irreversible acts get a confirmation (${shape}).`);
      const incumbent = await c.store(`Never force-push to a shared branch (${shape}).`, {
        kind: "rule", rule: { stage: `live successor ${shape}`, instance: `Bash:${shape}`, ...AGENT_RULE },
      });
      const successor = await c.store(`Lease-push instead on shared branches (${shape}).`, {
        kind: "rule", rule: { stage: `live successor ${shape}`, instance: `Bash:s-${shape}`, ...AGENT_RULE },
      });
      c.addLifecycleEdge({ family: "derivation", srcConceptId: principle, dstConceptId: incumbent.conceptId, bornOf: "extraction" });
      if (shape === "retired") {
        c.retireConcept(successor.conceptId);
      } else {
        // Rules reject flagContradiction directly; the supported route to a disputed advisory rule
        // is detach carrying an already-open dispute onto it (the same fixture the extraction
        // read-side test uses — and the exact route the finding named).
        const contested = await c.store(`A separate evidence packet is contested (${shape}).`, { kind: "fact", resolution: "forceNew" });
        const conflicting = await c.store(`That packet reads two ways (${shape}).`, { kind: "correction", attachTo: contested.conceptId });
        c.flagContradiction(contested.conceptId, { observationId: conflicting.observationId, kind: "value-conflict", detail: "contested" });
        await c.detach(contested.conceptId, [
          (await c.getConcept(contested.conceptId, { synthesize: false }))!.observations[0]!.id,
          conflicting.observationId,
        ], { destConceptId: successor.conceptId });
        expect((await c.getConcept(successor.conceptId))!.status).toBe("disputed");
      }

      expect(() => c.addLifecycleEdge({
        family: "supersession", srcConceptId: incumbent.conceptId, dstConceptId: successor.conceptId, bornOf: "correction",
      })).toThrow(/not active: a rule that cannot fire cannot replace/);
      expect(c.getLifecycleEdges(incumbent.conceptId, { direction: "out", family: "supersession" })).toEqual([]);
      expect(openImpeachments(c, principle)).toEqual([]);
      expect((await c.getConcept(principle))!.status).toBe("active");
    }
    c.close();
  });

  /**
   * AND AT THE SAME GATE (review fix — PR #112 round 6). succeedRule CARRIES the binding onto its
   * fresh successor; the raw writer records a succession between existing rules, so it validates
   * instead of performing — an active successor firing only at another stage would leave the
   * incumbent's gate without the replacement that justifies the removal (and the upward doubt).
   */
  it("refuses a raw supersession whose successor stands at a DIFFERENT gate", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation (cross-stage).");
    const incumbent = await c.store("Never force-push to a shared branch (cross-stage).", {
      kind: "rule", rule: { stage: "cross-stage gate", instance: "Bash:cross-stage", ...AGENT_RULE },
    });
    const elsewhere = await c.store("Snapshot volumes before stateful deletes (cross-stage).", {
      kind: "rule", rule: { stage: "cross-stage other gate", instance: "Bash:cross-stage-other", ...AGENT_RULE },
    });
    c.addLifecycleEdge({ family: "derivation", srcConceptId: principle, dstConceptId: incumbent.conceptId, bornOf: "extraction" });

    expect(() => c.addLifecycleEdge({
      family: "supersession", srcConceptId: incumbent.conceptId, dstConceptId: elsewhere.conceptId, bornOf: "correction",
    })).toThrow(/does not stand where the incumbent stands/);
    expect(c.getLifecycleEdges(incumbent.conceptId, { direction: "out", family: "supersession" })).toEqual([]);
    expect(openImpeachments(c, principle)).toEqual([]);
    // The incumbent still fires at its own gate — nothing was removed without a replacement.
    expect(c.gate({ actionContext: "Bash:cross-stage", record: false }).rules.map((r) => r.conceptId)).toContain(incumbent.conceptId);
    c.close();
  });

  /**
   * THE WHOLE DELIVERY ADDRESS, NOT JUST THE STAGE (review fix — PR #112 round 7). Gate delivery
   * routes on stage AND circle AND scope AND model tag; a domain incumbent "replaced" by one
   * model's compensation leaves every other model uncovered.
   */
  it("refuses a raw supersession whose successor serves a different AUDIENCE at the same gate", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation (audience).");
    const incumbent = await c.store("Never force-push to a shared branch (audience).", {
      kind: "rule", rule: { stage: "audience gate", instance: "Bash:audience", scope: "domain" },
    });
    const narrower = await c.store("Lease-push instead on shared branches (audience).", {
      kind: "rule", rule: { stage: "audience gate", instance: "Bash:audience-2", ...AGENT_RULE },
    });
    c.addLifecycleEdge({ family: "derivation", srcConceptId: principle, dstConceptId: incumbent.conceptId, bornOf: "extraction" });

    expect(() => c.addLifecycleEdge({
      family: "supersession", srcConceptId: incumbent.conceptId, dstConceptId: narrower.conceptId, bornOf: "correction",
    })).toThrow(/scope 'domain' vs 'agent'/);
    expect(c.getLifecycleEdges(incumbent.conceptId, { direction: "out", family: "supersession" })).toEqual([]);
    expect(openImpeachments(c, principle)).toEqual([]);
    c.close();
  });

  /**
   * A RETIRED INCUMBENT HAS NOTHING TO OVERTURN (review fix — PR #112 round 8). The ordinary
   * correction path refuses a retired target; the raw writer validated only the successor's side,
   * so a supersession of a rule that already stopped governing still disputed its live parents.
   */
  it("refuses a raw supersession whose incumbent is retired — no doubt from a dead rule", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation (retired incumbent).");
    const incumbent = await c.store("Never force-push to a shared branch (retired incumbent).", {
      kind: "rule", rule: { stage: "retired incumbent gate", instance: "Bash:ri", ...AGENT_RULE },
    });
    const successor = await c.store("Lease-push instead on shared branches (retired incumbent).", {
      kind: "rule", rule: { stage: "retired incumbent gate", instance: "Bash:ri-2", ...AGENT_RULE },
    });
    c.addLifecycleEdge({ family: "derivation", srcConceptId: principle, dstConceptId: incumbent.conceptId, bornOf: "extraction" });
    c.retireConcept(incumbent.conceptId);

    expect(() => c.addLifecycleEdge({
      family: "supersession", srcConceptId: incumbent.conceptId, dstConceptId: successor.conceptId, bornOf: "correction",
    })).toThrow(/incumbent .* is 'retired', not active/);
    expect(openImpeachments(c, principle)).toEqual([]);
    expect((await c.getConcept(principle))!.status).toBe("active");
    c.close();
  });

  /**
   * AND A DISPUTED INCUMBENT TOO (review fix — PR #112 round 9): gate liveness delivers only
   * active rules, so a disputed incumbent — reachable through the detach route — was not governing
   * either; its exit is mediation first, then the ordinary correction.
   */
  it("refuses a raw supersession whose incumbent is disputed — mediate first, then correct", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation (disputed incumbent).");
    const incumbent = await c.store("Never force-push to a shared branch (disputed incumbent).", {
      kind: "rule", rule: { stage: "disputed incumbent gate", instance: "Bash:di", ...AGENT_RULE },
    });
    const successor = await c.store("Lease-push instead on shared branches (disputed incumbent).", {
      kind: "rule", rule: { stage: "disputed incumbent gate", instance: "Bash:di-2", ...AGENT_RULE },
    });
    c.addLifecycleEdge({ family: "derivation", srcConceptId: principle, dstConceptId: incumbent.conceptId, bornOf: "extraction" });
    // The supported route to a disputed advisory rule: detach carries an open dispute onto it.
    const contested = await c.store("A separate evidence packet is contested (di).", { kind: "fact", resolution: "forceNew" });
    const conflicting = await c.store("That packet reads two ways (di).", { kind: "correction", attachTo: contested.conceptId });
    c.flagContradiction(contested.conceptId, { observationId: conflicting.observationId, kind: "value-conflict", detail: "contested" });
    await c.detach(contested.conceptId, [
      (await c.getConcept(contested.conceptId, { synthesize: false }))!.observations[0]!.id,
      conflicting.observationId,
    ], { destConceptId: incumbent.conceptId });
    expect((await c.getConcept(incumbent.conceptId))!.status).toBe("disputed");

    expect(() => c.addLifecycleEdge({
      family: "supersession", srcConceptId: incumbent.conceptId, dstConceptId: successor.conceptId, bornOf: "correction",
    })).toThrow(/incumbent .* is 'disputed', not active/);
    expect(c.getLifecycleEdges(incumbent.conceptId, { direction: "out", family: "supersession" })).toEqual([]);
    expect(openImpeachments(c, principle)).toEqual([]);
    c.close();
  });

  /**
   * AND NOT ITSELF ALREADY SUPERSEDED (review fix — PR #112 round 7). A superseded rule keeps
   * status 'active' by design, but no gate delivers it — the status check alone accepted a
   * replacement that cannot fire.
   */
  it("refuses a raw supersession whose successor is itself already superseded", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation (chained).");
    const other = await c.store("Never force-push to a shared branch (chained).", {
      kind: "rule", rule: { stage: "chained gate", instance: "Bash:chained", ...AGENT_RULE },
    });
    const dead = await c.store("Lease-push instead on shared branches (chained).", {
      kind: "rule", rule: { stage: "chained gate", instance: "Bash:chained-2", ...AGENT_RULE },
    });
    // Overturn `dead` through the ordinary path: still active, still bound, but no gate delivers it.
    await c.store("Force-push freely on throwaway spikes (chained).", { kind: "correction", attachTo: dead.conceptId });
    expect((await c.getConcept(dead.conceptId))!.status).toBe("active");
    c.addLifecycleEdge({ family: "derivation", srcConceptId: principle, dstConceptId: other.conceptId, bornOf: "extraction" });

    expect(() => c.addLifecycleEdge({
      family: "supersession", srcConceptId: other.conceptId, dstConceptId: dead.conceptId, bornOf: "correction",
    })).toThrow(/itself already superseded/);
    expect(c.getLifecycleEdges(other.conceptId, { direction: "out", family: "supersession" })).toEqual([]);
    expect(openImpeachments(c, principle)).toEqual([]);
    c.close();
  });

  it("impeaches through a PROJECTION edge too — 'doubt travels the parent edge, to projected children too'", async () => {
    const c = core();
    const principle = await principleOf(c, "A build artifact is a snapshot — re-materialize after the source changes.");
    // Born by projection, not by a human naming it in a ratification packet. No separate machinery
    // exists for this case, and that is the property under test.
    const projected = await c.store("Rebuild the image before deploying after a lockfile change.", {
      kind: "rule",
      rule: { stage: "docker build", instance: "Bash:docker build .", scope: "domain", projectedFromPrincipleId: principle },
    });
    expect(raw(c).prepare(
      `SELECT born_of FROM lifecycle_edges WHERE family='derivation' AND src_concept_id=? AND dst_concept_id=?`,
    ).get(principle, projected.conceptId)).toMatchObject({ born_of: "projection" });

    const correction = await c.store("Rebuild the image AND clear the layer cache after a lockfile change.", {
      kind: "correction", attachTo: projected.conceptId,
    });
    expect(correction.ruleSuccession!.impeachedPrincipleIds).toEqual([principle]);
    expect((await c.getConcept(principle))!.status).toBe("disputed");
    // "A wrong projection misfires in front of the human, and its correction births a
    // correction-born successor while impeaching the parent" — both halves, in one act.
    expect(c.ruleBinding(correction.conceptId)!.origin).toBe("correction");
    c.close();
  });

  it("skips a parent that is not an ACTIVE PRINCIPLE, and a parent this store has never received", async () => {
    const c = core();
    // (1) A PREFERENCE parent. Derivation is principle → rule by contract; a preference generates
    //     nothing, so a malformed edge naming one must not dispute it.
    const pref = await c.declare({ species: "preference", content: "Write as a peer." });
    if (pref.species !== "preference") throw new Error("unreachable");
    const ruleA = await c.store("Address the reader directly in commit messages.", {
      kind: "rule", rule: { stage: "git commit", instance: "Bash:git commit -m x", scope: "domain" },
    });
    c.addLifecycleEdge({ family: "derivation", srcConceptId: pref.conceptId, dstConceptId: ruleA.conceptId, bornOf: "extraction" });

    // (2) A parent that does not resolve locally — the relayed-edge case walkDerivation's own doc
    //     comment warns about. Written straight to the table, exactly as a graft would land it.
    const ruleB = await c.store("Squash before merging a long branch.", {
      kind: "rule", rule: { stage: "git merge", instance: "Bash:git merge --no-ff", scope: "domain" },
    });
    raw(c).prepare(
      `INSERT INTO lifecycle_edges (id, family, src_concept_id, dst_concept_id, born_of, event_ref, circle, created_at, sync_updated_at)
       VALUES ('orphan-edge','derivation','never-arrived',?,'ratification','r1','default',1,1)`,
    ).run(ruleB.conceptId);

    // Both corrections succeed — a missing or wrong-kind parent must never roll back the write.
    const cA = await c.store("Address the reader directly, and name the change.", { kind: "correction", attachTo: ruleA.conceptId });
    const cB = await c.store("Squash before merging, unless the history is the review.", { kind: "correction", attachTo: ruleB.conceptId });
    expect(cA.ruleSuccession!.impeachedPrincipleIds).toBeUndefined();
    expect(cB.ruleSuccession!.impeachedPrincipleIds).toBeUndefined();
    expect((await c.getConcept(pref.conceptId))!.status).toBe("active");
    expect(openImpeachments(c, pref.conceptId)).toEqual([]);
    c.close();
  });

  /**
   * MEMBERSHIP IS THE LATEST RULING, NOT THE STATUS (review fix — Codex 5-B round 2, R2-3). A
   * `retire` or `reject` verdict removes a principle from the skeleton without touching its concept
   * status: it stays `active` and stays kind `principle`, so a status-only guard let a correction on
   * any rule that ever carried a derivation edge from it open a fresh impeachment — a dispute
   * surfaced in curation about a principle the human already ruled out. Same live
   * latest-ratification-wins read `validateProjectionParent` uses on the projection entrance.
   */
  it("skips a parent whose LATEST RATIFICATION is not an entry verdict — retired by verdict, rejected, or never ratified", async () => {
    const c = core();
    /** A principle, a rule, a derivation edge between them, and the correction that kills the rule. */
    const impeachAttempt = async (principle: string, stage: string, text: string) => {
      const rule = await c.store(text, { kind: "rule", rule: { stage, instance: `Bash:${stage}`, scope: "domain" } });
      c.addLifecycleEdge({ family: "derivation", srcConceptId: principle, dstConceptId: rule.conceptId, bornOf: "extraction" });
      return c.store(`${text} — except on the first run.`, { kind: "correction", attachTo: rule.conceptId });
    };

    // (1) RETIRED BY VERDICT. The human already ended this principle through memory_ratify; the
    //     concept row never changed, which is exactly what the status-only guard could not see.
    const retiredByVerdict = await principleOf(c, "Irreversible acts get a confirmation.");
    await c.ratify({ candidateId: retiredByVerdict, verdict: "retire", ratifiedBy: "john" });
    expect((await c.getConcept(retiredByVerdict))!.status).toBe("active"); // the premise of the bug
    expect(c.skeleton("default").map((e) => e.conceptId)).not.toContain(retiredByVerdict);

    // (2) REJECTED, and never anything else. It was proposed and turned down: never a member.
    const rejected = await c.store("Every change ships behind a flag.", { kind: "principle" });
    await c.ratify({ candidateId: rejected.conceptId, verdict: "reject", ratifiedBy: "john" });

    // (3) NO RATIFICATION AT ALL. A principle-kind concept nobody has ruled on is not a skeleton
    //     member either, so doubt cast on it is noise on a curation surface.
    const unruled = await c.store("Prefer the smallest reversible step.", { kind: "principle" });

    const a = await impeachAttempt(retiredByVerdict, "helm delete", "Confirm the namespace before deleting a release.");
    const b = await impeachAttempt(rejected.conceptId, "kubectl apply", "Name the cluster before applying a manifest.");
    const d = await impeachAttempt(unruled.conceptId, "terraform apply", "Review the plan before applying it.");

    // THE CORRECTIONS ALL SUCCEED — each rule really was superseded; only the propagation is silent.
    for (const r of [a, b, d]) expect(r.ruleSuccession).toBeDefined();
    expect(a.ruleSuccession!.impeachedPrincipleIds).toBeUndefined();
    expect(b.ruleSuccession!.impeachedPrincipleIds).toBeUndefined();
    expect(d.ruleSuccession!.impeachedPrincipleIds).toBeUndefined();
    for (const id of [retiredByVerdict, rejected.conceptId, unruled.conceptId]) {
      expect(openImpeachments(c, id)).toEqual([]);
      expect((await c.getConcept(id))!.status).toBe("active");
    }
    c.close();
  });

  it("does not open a SECOND impeachment for the same superseded child", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation.");
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    c.addLifecycleEdge({ family: "derivation", srcConceptId: principle, dstConceptId: rule.conceptId, bornOf: "extraction" });

    // THE STATE THE SQL PROBE EXISTS FOR: an OPEN impeachment naming this exact child, on an ACTIVE
    // principle. `flagContradiction` opens it (and disputes the concept); the raw status write is
    // what no local path produces — see forceActiveWithOpenContradiction for why that is, and why
    // the probe is kept regardless.
    c.flagContradiction(principle, {
      kind: "impeachment",
      detail: `impeachment: superseded rule '${rule.conceptId}' ("Never force-push to a shared branch") was corrected — earlier`,
    });
    forceActiveWithOpenContradiction(c, principle);
    expect((await c.getConcept(principle))!.status).toBe("active");
    expect(openImpeachments(c, principle)).toHaveLength(1);

    const correction = await c.store("Force-push is fine on your own branch; never on a shared one.", {
      kind: "correction", attachTo: rule.conceptId,
    });
    // Still exactly one, and nothing claims to have impeached anything this time.
    expect(openImpeachments(c, principle)).toHaveLength(1);
    expect(correction.ruleSuccession!.impeachedPrincipleIds).toBeUndefined();
    c.close();
  });

  it("counts ONE impeachment when a principle reaches the same rule through two derivation edges", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation.");
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    // Derivation is deliberately NON-unique (lifecycle-edges.ts): a rule projected from a principle
    // and later named in that same principle's ratification packet legitimately carries two.
    c.addLifecycleEdge({ family: "derivation", srcConceptId: principle, dstConceptId: rule.conceptId, bornOf: "projection" });
    c.addLifecycleEdge({ family: "derivation", srcConceptId: principle, dstConceptId: rule.conceptId, bornOf: "extraction" });

    const correction = await c.store("Force-push is fine on your own branch; never on a shared one.", {
      kind: "correction", attachTo: rule.conceptId,
    });
    expect(correction.ruleSuccession!.impeachedPrincipleIds).toEqual([principle]);
    expect(openImpeachments(c, principle)).toHaveLength(1);
    c.close();
  });

  /**
   * THE ALREADY-DISPUTED PARENT (review fix — Codex 5-B round 1, F1). The propagation guard used to
   * require `status = 'active'`, on the reasoning that a disputed principle is already out of
   * delivery and already in front of the human. That is true of the STATUS and false of the
   * QUESTION: two derived siblings corrected before either impeachment is mediated are two distinct
   * reasons to doubt the parent, and the second one was being dropped. Mediating the single recorded
   * contradiction then restored the principle — `recomputeNativeConceptProjection` reads
   * `open_count`, so one open row closed means zero open rows — and the skeleton got back a
   * principle whose OTHER derived rule had also just been overturned, with nothing anywhere saying
   * so. Each superseded child now earns its own impeachment; only the last one closed restores
   * membership.
   */
  it("opens a SECOND impeachment when another sibling rule dies while the parent is already disputed", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation.");
    const ruleA = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    const ruleB = await c.store("Confirm the target namespace before deleting a release.", {
      kind: "rule", rule: { stage: "helm delete", instance: "Bash:helm delete my-release", scope: "domain" },
    });
    await c.ratify({
      candidateId: principle, verdict: "re-ratify", ratifiedBy: "john",
      memberRuleIds: [ruleA.conceptId, ruleB.conceptId],
    });

    const first = await c.store("Force-push is fine on your own branch; never on a shared one.", {
      kind: "correction", attachTo: ruleA.conceptId,
    });
    expect(first.ruleSuccession!.impeachedPrincipleIds).toEqual([principle]);
    expect((await c.getConcept(principle))!.status).toBe("disputed");

    // THE CORNER: the parent is ALREADY disputed, and this is a DIFFERENT child dying.
    const second = await c.store("Confirm the namespace AND the release name before deleting.", {
      kind: "correction", attachTo: ruleB.conceptId,
    });
    expect(second.ruleSuccession!.impeachedPrincipleIds).toEqual([principle]);
    const impeachments = openImpeachments(c, principle);
    expect(impeachments).toHaveLength(2);
    expect(impeachments.map((i) => i.status)).toEqual(["open", "open"]);
    expect(impeachments.some((i) => i.detail.includes(`superseded rule '${ruleA.conceptId}'`))).toBe(true);
    expect(impeachments.some((i) => i.detail.includes(`superseded rule '${ruleB.conceptId}'`))).toBe(true);

    // MEDIATING ONE IS NOT MEDIATING BOTH — the principle stays out of the skeleton while the other
    // overturned rule is still an open question. This is the silent restore the finding names.
    c.resolveContradiction(impeachments[0]!.id, { decision: "dismiss", by: "john" });
    expect((await c.getConcept(principle))!.status).toBe("disputed");
    expect(c.skeleton("default").map((e) => e.conceptId)).not.toContain(principle);

    // ...and only the LAST one closed brings it back.
    c.resolveContradiction(openImpeachments(c, principle).find((i) => i.status === "open")!.id, { decision: "dismiss", by: "john" });
    expect((await c.getConcept(principle))!.status).toBe("active");
    expect(c.skeleton("default").map((e) => e.conceptId)).toContain(principle);
    c.close();
  });

  /**
   * IDEMPOTENCY SURVIVES THE WIDENING (review fix — Codex 5-B round 1, F1). The sibling test above
   * proves a disputed parent can now be impeached again; this proves the widening did not turn the
   * per-(parent, superseded child) probe into a no-op. It is the same fixture as the active-parent
   * idempotency test above WITHOUT `forceActiveWithOpenContradiction` — which is the whole point:
   * "disputed with an open impeachment naming this child" is the state the ordinary path actually
   * produces, and until this fix the status guard, not the probe, was what stopped the second row.
   */
  it("still opens only ONE impeachment per (parent, superseded child) when the parent is DISPUTED", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation.");
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    c.addLifecycleEdge({ family: "derivation", srcConceptId: principle, dstConceptId: rule.conceptId, bornOf: "extraction" });
    // An impeachment naming THIS child is already open, and the parent is disputed by it — the
    // ordinary state, no raw status write needed.
    c.flagContradiction(principle, {
      kind: "impeachment",
      detail: `impeachment: superseded rule '${rule.conceptId}' ("Never force-push to a shared branch") was corrected — earlier`,
    });
    expect((await c.getConcept(principle))!.status).toBe("disputed");

    const correction = await c.store("Force-push is fine on your own branch; never on a shared one.", {
      kind: "correction", attachTo: rule.conceptId,
    });
    expect(openImpeachments(c, principle)).toHaveLength(1);
    expect(correction.ruleSuccession!.impeachedPrincipleIds).toBeUndefined();
    c.close();
  });

  it("THE ORDINARY LOOP: an impeached principle mediates first, then re-ratifies back into the skeleton", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation.");
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    c.addLifecycleEdge({ family: "derivation", srcConceptId: principle, dstConceptId: rule.conceptId, bornOf: "extraction" });
    await c.store("Force-push is fine on your own branch; never on a shared one.", { kind: "correction", attachTo: rule.conceptId });
    expect(openImpeachments(c, principle)[0]!.status).toBe("open");
    expect(c.skeleton("default").map((e) => e.conceptId)).not.toContain(principle);

    // PINNED, NOT ASSUMED: 5-A refuses an entry verdict on a disputed candidate outright, so
    // re-ratification is NOT the first move after an impeachment — mediation is. 5-B deliberately
    // does not relax that guard, so this is the shape of the whole re-ratify half of the loop.
    await expect(c.ratify({ candidateId: principle, verdict: "re-ratify" }))
      .rejects.toThrow(/is disputed: an open contradiction contests it.*Mediate the contradiction/s);

    // memory_resolve answers the impeachment and restores 'active'; membership follows from the
    // ruling that was already on record, and a fresh re-ratification is then accepted.
    const contradictionId = openImpeachments(c, principle)[0]!.id;
    c.resolveContradiction(contradictionId, { decision: "dismiss", by: "john" });
    expect((await c.getConcept(principle))!.status).toBe("active");
    expect(c.skeleton("default").map((e) => e.conceptId)).toContain(principle);
    const ratified = await c.ratify({ candidateId: principle, verdict: "re-ratify", ratifiedBy: "john" });
    // Nothing left to close — mediation already did it. The field is omitted rather than reported 0.
    expect(ratified.impeachmentsClosed).toBeUndefined();
    c.close();
  });

  it("closes an impeachment a re-ratification re-ruled on, when one is still open at that moment", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation.");
    c.flagContradiction(principle, { kind: "impeachment", detail: "superseded rule 'r1' was corrected" });
    // See forceActiveWithOpenContradiction: no local path produces this state today, and the branch
    // is kept because "an impeachment the human has re-ruled on must not stay open" is a property of
    // the verdict, not of which route reached it.
    forceActiveWithOpenContradiction(c, principle);

    const ratified = await c.ratify({ candidateId: principle, verdict: "re-ratify", ratifiedBy: "john" });
    expect(ratified.impeachmentsClosed).toBe(1);
    expect(openImpeachments(c, principle)[0]).toMatchObject({ status: "resolved", resolved_by: "john" });
    expect((await c.getConcept(principle))!.status).toBe("active");
    expect(c.skeleton("default").map((e) => e.conceptId)).toContain(principle);
    c.close();
  });

  it("a RETIRE verdict closes it too — the concept leaves delivery either way, and curation should not keep the question", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation.");
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    c.addLifecycleEdge({ family: "derivation", srcConceptId: principle, dstConceptId: rule.conceptId, bornOf: "extraction" });
    await c.store("Force-push is fine on your own branch; never on a shared one.", { kind: "correction", attachTo: rule.conceptId });

    // Retire is NOT refused on a disputed candidate (only approve/re-ratify are) — this is the
    // reachable half of the loop: the human agrees the impeachment stands and ends the principle.
    const retired = await c.ratify({ candidateId: principle, verdict: "retire", ratifiedBy: "john" });
    expect(retired.impeachmentsClosed).toBe(1);
    expect(openImpeachments(c, principle)[0]).toMatchObject({ status: "resolved", resolved_by: "john" });
    // Out of the skeleton by VERDICT now, not by status — which is why closing the contradiction is
    // safe: membership reads the latest ruling, and the latest ruling is 'retire'.
    expect(c.skeleton("default").map((e) => e.conceptId)).not.toContain(principle);
    c.close();
  });

  it("leaves an ordinary value-conflict alone: only impeachments are closed by a verdict", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation.");
    // A dispute about the principle's CONTENT is a different question from an impeachment, and it
    // belongs to memory_resolve. A ratification verdict must not silently answer it.
    c.flagContradiction(principle, { kind: "value-conflict", detail: "someone disagrees with the wording" });
    forceActiveWithOpenContradiction(c, principle);
    const r = await c.ratify({ candidateId: principle, verdict: "re-ratify", ratifiedBy: "john" });
    expect(r.impeachmentsClosed).toBeUndefined();
    expect((raw(c).prepare(`SELECT status FROM contradictions WHERE concept_id = ?`).get(principle) as { status: string }).status)
      .toBe("open");
    c.close();
  });

  /**
   * ONE TRANSACTION FOR THE WHOLE VERDICT (review fix — Codex 5-B round 1, F4). `ratify()` used to
   * commit the ratification and its derivation edges in `ratifySkeletonMembership`'s transaction and
   * THEN close the impeachments in a second one. A failure — or a crash — between them left the
   * durable half of a contradiction in state: a recorded verdict that says the human ruled on the
   * impeachment, and the impeachment still open, with `ratify()` reporting an error to a caller who
   * would reasonably retry. Same reasoning as `StoreOpts.skeletonEntry` riding store()'s own
   * transaction, and the same shape: the dependent act runs inside the primary act's envelope.
   */
  it("records the verdict, its edges and the impeachment closure in ONE transaction — a failed closure commits neither", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation.");
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    c.addLifecycleEdge({ family: "derivation", srcConceptId: principle, dstConceptId: rule.conceptId, bornOf: "extraction" });
    await c.store("Force-push is fine on your own branch; never on a shared one.", { kind: "correction", attachTo: rule.conceptId });
    expect(openImpeachments(c, principle)[0]!.status).toBe("open");
    const verdictsBefore = c.getRatifications(principle).length;

    // FAULT INJECTION at the closure step — the trigger shape circle-lifecycle.test.ts already uses
    // to prove a multi-step mutation is atomic.
    const db = (c as unknown as { db: StoragePort }).db;
    db.exec(`
      CREATE TRIGGER inject_impeachment_closure_failure
      BEFORE UPDATE OF status ON contradictions
      WHEN NEW.status = 'resolved'
      BEGIN
        SELECT RAISE(ABORT, 'injected impeachment-closure failure');
      END;
    `);

    await expect(c.ratify({ candidateId: principle, verdict: "retire", ratifiedBy: "john" }))
      .rejects.toThrow(/injected impeachment-closure failure/);

    // ALL OR NOTHING: no verdict on record (so nothing claims the human ruled), the impeachment
    // still open, and the principle still out of the skeleton by its own disputed status.
    expect(c.getRatifications(principle)).toHaveLength(verdictsBefore);
    expect(c.getRatifications(principle).some((r) => r.verdict === "retire")).toBe(false);
    expect(openImpeachments(c, principle)[0]!.status).toBe("open");

    // HAPPY PATH UNCHANGED once the injected failure is gone — both halves land together.
    db.exec(`DROP TRIGGER inject_impeachment_closure_failure`);
    const retired = await c.ratify({ candidateId: principle, verdict: "retire", ratifiedBy: "john" });
    expect(retired.impeachmentsClosed).toBe(1);
    expect(c.getRatifications(principle).some((r) => r.verdict === "retire")).toBe(true);
    expect(openImpeachments(c, principle)[0]).toMatchObject({ status: "resolved", resolved_by: "john" });
    c.close();
  });

  /** The same atomicity, from the OTHER side: a member-edge failure must not leave an impeachment
   *  closed on the strength of a verdict that never committed. */
  it("does not close an impeachment when the ratification's own member edge fails", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation.");
    c.flagContradiction(principle, { kind: "impeachment", detail: "superseded rule 'r1' was corrected" });
    forceActiveWithOpenContradiction(c, principle);
    // A member id naming a FACT is refused inside ratifySkeletonMembership, before any edge is
    // written — and now, with the closure inside the same envelope, before any closure either.
    const fact = await c.store("SQLite is the storage backend.");
    await expect(c.ratify({
      candidateId: principle, verdict: "re-ratify", ratifiedBy: "john", memberRuleIds: [fact.conceptId],
    })).rejects.toThrow(/is kind 'fact', not 'rule'/);
    expect(openImpeachments(c, principle)[0]!.status).toBe("open");
    c.close();
  });
});

describe("5-B: the projection write path", () => {
  const principleOf = async (c: MonetCore, content: string, circle?: string): Promise<string> => {
    const r = await c.declare({ species: "principle", content, circle });
    if (r.species !== "principle") throw new Error("unreachable");
    return r.conceptId;
  };

  it("writes ONE derivation edge, flips the binding to origin 'projection', and announces the parent at every fire", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation.");
    const projected = await c.store("Confirm the target namespace before deleting a release.", {
      kind: "rule",
      rule: { stage: "helm delete", instance: "Bash:helm delete my-release", scope: "domain", projectedFromPrincipleId: principle },
    });

    const edges = raw(c).prepare(
      `SELECT src_concept_id, dst_concept_id, born_of, event_ref FROM lifecycle_edges WHERE family='derivation'`,
    ).all() as Array<{ src_concept_id: string; dst_concept_id: string; born_of: string; event_ref: string }>;
    expect(edges).toEqual([{
      src_concept_id: principle,
      dst_concept_id: projected.conceptId,
      born_of: "projection",
      // The birth ACT, not the concept: "an edge is always the record of something that HAPPENED".
      event_ref: projected.observationId,
    }]);
    expect(c.ruleBinding(projected.conceptId)!.origin).toBe("projection");

    // "A firing projected rule announces its provenance" — the whole reason projection needs no
    // approval gate is that a wrong one misfires in front of the human.
    const fired = c.gate({ actionContext: "Bash:helm delete my-release" });
    expect(fired.rules[0]).toMatchObject({ conceptId: projected.conceptId, projectedFromPrincipleId: principle, origin: "projection" });
    // Nothing is disputed yet, so no doubt is announced (D5's own field, omitted rather than false).
    expect(fired.rules[0]!.parentDisputed).toBeUndefined();
    c.close();
  });

  it("names every refusal: missing parent, a preference, a disputed parent, an unratified principle, a foreign circle, and blocking severity", async () => {
    const c = core();
    const project = (opts: Record<string, unknown>) =>
      c.store("Confirm the namespace first.", {
        ...opts,
        kind: "rule",
        rule: { stage: "helm delete", scope: "domain", ...(opts.rule as object ?? {}) },
      } as never);

    // (1) DOES NOT EXIST.
    await expect(project({ rule: { projectedFromPrincipleId: "no-such-concept" } }))
      .rejects.toThrow(/'no-such-concept' does not exist: a projected rule names the skeleton principle/);

    // (2) NOT A PRINCIPLE — a preference is momentless and generates nothing.
    const pref = await c.declare({ species: "preference", content: "Write as a peer." });
    if (pref.species !== "preference") throw new Error("unreachable");
    await expect(project({ rule: { projectedFromPrincipleId: pref.conceptId } }))
      .rejects.toThrow(/is kind 'preference', not 'principle': only a principle derives rules downward/);

    // (3) NOT ACTIVE — a principle currently under impeachment governs nothing.
    const disputed = await principleOf(c, "Irreversible acts get a confirmation.");
    c.flagContradiction(disputed, { kind: "impeachment", detail: "under review" });
    await expect(project({ rule: { projectedFromPrincipleId: disputed } }))
      .rejects.toThrow(/is 'disputed', not active: a contested or retired principle governs nothing/);

    // (4) NOT A CURRENT SKELETON MEMBER — the live latest-ratification-wins read, not a status
    //     check: this principle is active and is a principle, and its LATEST verdict is 'retire'.
    const unratified = await c.store("A retired principle is still a principle.", { kind: "principle" });
    await expect(project({ rule: { projectedFromPrincipleId: unratified.conceptId } }))
      .rejects.toThrow(/is not a current skeleton member \(no ratification on record\)/);
    await c.ratify({ candidateId: unratified.conceptId, verdict: "approve" });
    await c.ratify({ candidateId: unratified.conceptId, verdict: "retire" });
    await expect(project({ rule: { projectedFromPrincipleId: unratified.conceptId } }))
      .rejects.toThrow(/is not a current skeleton member \(latest verdict 'retire'\)/);

    // (5) ANOTHER CIRCLE — precheck for a better error; addLifecycleEdge refuses it regardless.
    const elsewhere = await principleOf(c, "Prefer the smallest reversible step.", "other-circle");
    await expect(project({ rule: { projectedFromPrincipleId: elsewhere } }))
      .rejects.toThrow(/is in circle 'other-circle', but the rule is being written to 'default'/);

    // (6) BLOCKING — refused even on the declaration path, which is the only path that could ever
    //     have reached it: "no agent, and NO PROJECTION, can self-assign deny power."
    const live = await principleOf(c, "Nothing waits on scheduled review.");
    await expect(project({
      rule: { projectedFromPrincipleId: live, severity: "blocking", declaration: true, reason: "there is no undo" },
    })).rejects.toThrow(/a projected rule cannot be blocking: projection is structurally advisory-only/);

    // NOTHING LANDED from any of the six — every refusal precedes the write.
    expect(raw(c).prepare(`SELECT COUNT(*) AS n FROM lifecycle_edges WHERE family='derivation' AND born_of='projection'`).get())
      .toMatchObject({ n: 0 });
    expect(c.stages().some((s) => s.name === "helm delete")).toBe(false);
    c.close();
  });

  it("the public raw projection writer enforces the parent, destination, severity, and mirror invariants", async () => {
    const c = core();
    const legalParent = await principleOf(c, "Irreversible acts get a confirmation.");
    const legalRule = await c.store("Confirm the target namespace before deleting a release.", {
      kind: "rule", rule: { stage: "helm delete", instance: "Bash:helm delete my-release", scope: "domain" },
    });
    const generationBefore = c.sidecarGeneration();
    c.addLifecycleEdge({
      family: "derivation", srcConceptId: legalParent, dstConceptId: legalRule.conceptId,
      bornOf: "projection", eventRef: legalRule.observationId,
    });
    expect(c.sidecarGeneration()).toBeGreaterThan(generationBefore);
    expect(c.gate({ actionContext: "Bash:helm delete my-release", record: false }).rules[0])
      .toMatchObject({ conceptId: legalRule.conceptId, projectedFromPrincipleId: legalParent });

    const project = (srcConceptId: string, dstConceptId: string) => () => c.addLifecycleEdge({
      family: "derivation", srcConceptId, dstConceptId, bornOf: "projection",
    });
    const preference = await c.declare({ species: "preference", content: "Write as a peer." });
    if (preference.species !== "preference") throw new Error("unreachable");
    expect(project(preference.conceptId, legalRule.conceptId))
      .toThrow(/is kind 'preference', not 'principle': only a principle derives rules downward/);

    const disputed = await principleOf(c, "Prefer the smallest reversible step.");
    c.flagContradiction(disputed, { kind: "impeachment", detail: "under review" });
    expect(project(disputed, legalRule.conceptId))
      .toThrow(/is 'disputed', not active: a contested or retired principle governs nothing/);

    const retiredByVerdict = await principleOf(c, "Nothing waits on scheduled review.");
    await c.ratify({ candidateId: retiredByVerdict, verdict: "retire", ratifiedBy: "john" });
    expect(project(retiredByVerdict, legalRule.conceptId))
      .toThrow(/is not a current skeleton member \(latest verdict 'retire'\)/);

    const neverRatified = await c.store("A candidate principle awaits a ruling.", { kind: "principle" });
    expect(project(neverRatified.conceptId, legalRule.conceptId))
      .toThrow(/is not a current skeleton member \(no ratification on record\)/);

    const deny = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"], scope: "domain",
      content: "Never delete a directory tree unattended.", severity: "blocking",
      reason: "there is no undo", declaredBy: "john",
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    expect(project(legalParent, deny.conceptId)).toThrow(/cannot be projected onto: it is a blocking rule/);

    const fact = await c.store("SQLite is the storage backend.");
    expect(project(legalParent, fact.conceptId))
      .toThrow(/cannot be projection-born: projection births gate rules, but it is kind 'fact'/);
    c.close();
  });

  it("re-projection is a cache hit: attaching to the existing rule adds no second edge and does not rewrite its binding", async () => {
    // SHIPPING THRESHOLDS: identical evidence must resolve onto the one rule concept, which is
    // exactly what "a projected rule is a cache hit next firing" means at the store.
    const c = resolvingCore();
    const principle = await principleOf(c, "Irreversible acts get a confirmation.");
    const text = "Confirm the target namespace before deleting a release.";
    const first = await c.store(text, {
      kind: "rule", rule: { stage: "helm delete", instance: "Bash:helm delete my-release", scope: "domain", projectedFromPrincipleId: principle },
    });
    const second = await c.store(text, {
      kind: "rule", rule: { stage: "helm delete", scope: "domain", projectedFromPrincipleId: principle },
    });
    expect(second.action).toBe("attached");
    expect(second.conceptId).toBe(first.conceptId);
    // ONE PROJECTION EDGE, and one derivation edge in total — the dedupe that makes a re-projection
    // a cache hit is per `born_of`, and there is only ever one projection act to record here.
    expect(raw(c).prepare(
      `SELECT COUNT(*) AS n FROM lifecycle_edges WHERE family='derivation' AND src_concept_id=? AND dst_concept_id=?`,
    ).get(principle, first.conceptId)).toMatchObject({ n: 1 });
    expect(raw(c).prepare(
      `SELECT COUNT(*) AS n FROM lifecycle_edges WHERE family='derivation' AND born_of='projection' AND src_concept_id=? AND dst_concept_id=?`,
    ).get(principle, first.conceptId)).toMatchObject({ n: 1 });

    // A RATIFICATION-BORN EDGE DOES NOT SUPPRESS THE PROJECTION RECORD (review fix — Codex 5-B round
    // 4, R4-1). This assertion is INVERTED from the one it replaces, deliberately: the dedupe used to
    // be on (src, dst) for ANY born_of, on the reasoning that a later projection must not mint a
    // "weaker record of a relationship the human already ratified". The relationship is not what
    // these rows are — they are ACTS on an append-only log — and swallowing the projection act made
    // the slice's own operative test ("ever projected onto = excluded from extraction evidence")
    // depend on which edge happened to land first. Both acts are now on record, oldest first.
    const other = await c.store("Announce a release deletion in the ops channel.", {
      kind: "rule", rule: { stage: "helm announce", instance: "Bash:helm list", scope: "domain" },
    });
    await c.ratify({ candidateId: principle, verdict: "re-ratify", memberRuleIds: [other.conceptId] });
    await c.store("Announce a release deletion in the ops channel.", {
      kind: "rule", rule: { stage: "helm announce", scope: "domain", projectedFromPrincipleId: principle },
    });
    const bornOf = raw(c).prepare(
      `SELECT born_of FROM lifecycle_edges WHERE family='derivation' AND src_concept_id=? AND dst_concept_id=?
        ORDER BY created_at ASC, id ASC`,
    ).all(principle, other.conceptId) as Array<{ born_of: string }>;
    expect(bornOf.map((e) => e.born_of)).toEqual(["ratification", "projection"]);

    // AND THE HUMAN'S RULING IS STILL THE ONE DELIVERY NAMES — the parent pick is a correlated
    // scalar ordered oldest-first with LIMIT 1, so two acts still report exactly one parent, and
    // walkDerivation is DISTINCT, so the principle's member list does not repeat the rule.
    expect(c.gate({ actionContext: "Bash:helm list", record: false }).rules[0])
      .toMatchObject({ conceptId: other.conceptId, projectedFromPrincipleId: principle });
    expect(c.walkDerivation(principle, "out").filter((id) => id === other.conceptId)).toEqual([other.conceptId]);
    c.close();
  });

  /**
   * THE FIRST-WRITE-WINS BUG THIS CLOSES (review fix — Codex 5-B round 4, R4-1), stated as the state
   * it produced rather than as the code that produced it: a rule the human had already ratified as a
   * member of principle P carried a `born_of = 'ratification'` edge from P, so when P later PROJECTED
   * onto that same rule, the old any-`born_of` dedupe returned without recording the projection at
   * all. Nothing durable then said the principle had generated it — and both readers of that fact ask
   * for `born_of = 'projection'` by name (`isProjectionBorn` at flag time,
   * `EXTRACTION_PAIR_NOT_PROJECTION_BORN` on the read side, round 3 R3-2) — so the rule stayed
   * admissible as extraction evidence for the very principle that had projected it. That is the
   * circular-support case the exclusion exists to prevent, reachable purely by ordering.
   *
   * The read-side assertion here is deliberately the SAME SHAPE as R3-2's own test: the pair is
   * flagged and reported while both rules are ordinary, and stops being reported the moment one of
   * them becomes projection-born. Only the ROUTE to bornness differs — through a rule that already
   * had a ratification edge from the same principle.
   */
  it("records the projection onto a rule the same principle already ratified — bornness is not first-write-wins", async () => {
    // The ambiguous band, so two near-matching rules at different stages fork into a flagged pair;
    // identical text still ATTACHES, which is how the later projection lands on an existing rule.
    const c = new MonetCore(":memory:", { tauAttach: 0.99, tauAmbiguous: 0.1 });
    const ruleAt = (text: string, stage: string, instance: string) =>
      c.store(text, { kind: "rule", rule: { stage, instance, scope: "domain" } });
    const first = await ruleAt("Verify the built artifact after the source changes.", "docker build", "Bash:docker build .");
    const second = await ruleAt("After the source changes, verify the artifact itself.", "npm install", "Bash:npm install");
    expect(second.extractionCandidate).toMatchObject({ pairedRuleId: first.conceptId });
    expect(c.overview("default").counts.extractionCandidates).toBe(1);

    const principle = await principleOf(c, "A build artifact is a snapshot; re-materialize after the source changes.");

    // (1) THE HUMAN RULES FIRST: a ratification-born edge principle → `first`. Naming ONE rule of
    //     the pair does not answer the pair's own question, so the flag is still open (R4-4 resolves
    //     it only when BOTH are named) — which is what makes step (2) observable at all.
    await c.ratify({ candidateId: principle, verdict: "re-ratify", memberRuleIds: [first.conceptId], ratifiedBy: "john" });
    expect(c.overview("default").counts.extractionCandidates).toBe(1);

    // (2) THE PROJECTION LANDS SECOND, onto that very rule — a cache hit on the attach path.
    const projection = await c.store("Verify the built artifact after the source changes.", {
      kind: "rule",
      rule: { stage: "docker build", instance: "Bash:docker build .", scope: "domain", projectedFromPrincipleId: principle },
    });
    expect(projection.action).toBe("attached");
    expect(projection.conceptId).toBe(first.conceptId);

    // BOTH ACTS ARE ON RECORD — the human's ruling and the substrate's projection, in that order.
    const bornOf = raw(c).prepare(
      `SELECT born_of FROM lifecycle_edges WHERE family='derivation' AND src_concept_id=? AND dst_concept_id=?
        ORDER BY created_at ASC, id ASC`,
    ).all(principle, first.conceptId) as Array<{ born_of: string }>;
    expect(bornOf.map((e) => e.born_of)).toEqual(["ratification", "projection"]);

    // AND THE READ SIDE SEES IT: the rule is projection-born now, so the pair is no longer offered
    // as extraction evidence for anything — the exclusion that used to depend on write order.
    const after = c.overview("default");
    expect(after.counts.extractionCandidates).toBe(0);
    expect(after.extractionCandidates).toEqual([]);
    c.close();
  });

  /**
   * THE SYMMETRY CHECK (review fix — Codex 5-B round 4, R4-1). R4-1's finding was ONE-DIRECTIONAL:
   * only `recordProjectionEdge` deduped, so only the projection act could be swallowed.
   * `ratifySkeletonMembership` writes its member edges unconditionally and always has — it has no
   * existence probe at all — so the reverse order was never lossy. That is worth PINNING rather than
   * merely arguing, because the tempting "fix" for the original finding was to widen the dedupe to
   * both entrances, which would have taught the ratify path to swallow a human's act.
   */
  it("records the human's ratification even when the rule already carries a projection edge from the same principle", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation.");
    const projected = await c.store("Confirm the target namespace before deleting a release.", {
      kind: "rule",
      rule: { stage: "helm delete", instance: "Bash:helm delete my-release", scope: "domain", projectedFromPrincipleId: principle },
    });
    expect(raw(c).prepare(
      `SELECT born_of FROM lifecycle_edges WHERE family='derivation' AND src_concept_id=? AND dst_concept_id=?`,
    ).all(principle, projected.conceptId)).toMatchObject([{ born_of: "projection" }]);

    // The human now names that same rule as evidence for the same principle. A projection is the
    // substrate's inference; a ratification is a person's ruling, and the log owes both.
    const ratified = await c.ratify({
      candidateId: principle, verdict: "re-ratify", memberRuleIds: [projected.conceptId], ratifiedBy: "john",
    });
    expect(ratified.edgeIds).toHaveLength(1);
    const bornOf = raw(c).prepare(
      `SELECT born_of FROM lifecycle_edges WHERE family='derivation' AND src_concept_id=? AND dst_concept_id=?
        ORDER BY created_at ASC, id ASC`,
    ).all(principle, projected.conceptId) as Array<{ born_of: string }>;
    expect(bornOf.map((e) => e.born_of)).toEqual(["projection", "ratification"]);
    // The rule is projection-born either way — a human agreeing does not un-manufacture the support.
    expect(c.gate({ actionContext: "Bash:helm delete my-release", record: false }).rules[0])
      .toMatchObject({ conceptId: projected.conceptId, projectedFromPrincipleId: principle, origin: "projection" });
    c.close();
  });

  /**
   * THE OTHER HALF OF "NO PROJECTION CAN SELF-ASSIGN DENY POWER" (review fix — Codex 5-B round 2,
   * R2-5). `validateRuleCapture` refuses a projection that ASKS for blocking, which closes the case
   * where severity is stated. It cannot see the case where severity is not stated at all: an omitted
   * severity is not a value, so a projection landing on an existing declaration-born blocking rule
   * passes validation, `captureRuleBinding` keeps the incumbent binding untouched — still blocking —
   * and the projection edge is recorded anyway. The result is the forbidden object: a rule that is
   * blocking AND projection-born, which no path was supposed to be able to mint.
   *
   * REFUSING THE WHOLE WRITE is the right shape, not "record the attach and skip the edge": the
   * caller asked for a projection, the projection is illegal, and a silently-downgraded write would
   * leave them believing a parent edge exists. The attach they could have had legally is one
   * argument away, which the last case here proves.
   */
  it("REFUSES a projection onto an existing BLOCKING rule, however the severity was left — the resolved binding is what decides", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation.");
    const deny = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"], scope: "domain",
      content: "Never delete a directory tree unattended.", severity: "blocking",
      reason: "there is no undo", declaredBy: "john",
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    const observationsBefore = (raw(c).prepare(`SELECT COUNT(*) AS n FROM observations`).get() as { n: number }).n;

    // (1) SEVERITY OMITTED — the case the stated-severity guard structurally cannot see.
    await expect(c.store("Also confirm the target path before deleting it.", {
      kind: "rule", attachTo: deny.conceptId,
      rule: { stage: "rm -rf", scope: "domain", projectedFromPrincipleId: principle },
    })).rejects.toThrow(/cannot be projected onto: it is a blocking rule/);

    // (2) SEVERITY 'advisory' — an explicit advisory does not demote the incumbent either (an
    //     omitted-or-advisory capture preserves the recorded ruling), so it reaches the same state.
    await expect(c.store("Also confirm the target path before deleting it.", {
      kind: "rule", attachTo: deny.conceptId,
      rule: { stage: "rm -rf", scope: "domain", severity: "advisory", projectedFromPrincipleId: principle },
    })).rejects.toThrow(/cannot be projected onto: it is a blocking rule/);

    // NOTHING LANDED from either — the refusal is inside the transaction, so the observation goes
    // down with it. And the deny is untouched: still blocking, still declaration-born.
    expect((raw(c).prepare(`SELECT COUNT(*) AS n FROM observations`).get() as { n: number }).n).toBe(observationsBefore);
    expect(raw(c).prepare(`SELECT COUNT(*) AS n FROM lifecycle_edges WHERE family='derivation'`).get()).toMatchObject({ n: 0 });
    expect(c.ruleBinding(deny.conceptId)).toMatchObject({ severity: "blocking", origin: "declaration" });

    // THE SAME STORE WITHOUT THE PROJECTION CLAIM IS STILL LEGAL. Attaching evidence to a blocking
    // rule was never the problem — claiming a principle derived it is.
    const attached = await c.store("Also confirm the target path before deleting it.", {
      kind: "rule", attachTo: deny.conceptId, rule: { stage: "rm -rf", scope: "domain" },
    });
    expect(attached.action).toBe("attached");
    expect(attached.conceptId).toBe(deny.conceptId);
    expect(c.ruleBinding(deny.conceptId)).toMatchObject({ severity: "blocking", origin: "declaration" });
    c.close();
  });

  /**
   * THE PREFLIGHT-VS-WRITE RACE (review fix — Codex 5-B round 1, F2). `validateProjectionParent`
   * runs from `validateRuleCapture`, which storeInternal calls BEFORE `await checkedEmbed(...)` and
   * therefore before the write transaction opens. Anything that disputes, retires or re-rules on the
   * parent during that await had already been validated past: `recordProjectionEdge` delegates to
   * `addLifecycleEdge`, which rechecks endpoint existence, governability and circle but knows
   * nothing about kind `principle`, active status or the latest ratification — so every guard this
   * entrance advertises could be walked around by losing that race.
   *
   * The embed await IS the window, so this test opens it deliberately rather than approximating it:
   * the embedding call disputes the parent on its way out, exactly as a concurrent correction on a
   * sibling rule would.
   */
  type Embedder = { checkedEmbed(text: string, domain: string): Promise<Float32Array> };
  const raceOnEmbed = (c: MonetCore, duringEmbed: () => void | Promise<void>): { restore(): void } => {
    const original = (Object.getPrototypeOf(c) as Embedder).checkedEmbed;
    let raced = false;
    // Own-property spy on THIS core only (never the prototype), restored by the caller — the same
    // discipline this file's `randomUUID` note insists on for its own file-wide mock.
    const spy = vi.spyOn(c as unknown as Embedder, "checkedEmbed").mockImplementation(async (text: string, domain: string) => {
      const emb = await original.call(c, text, domain);
      if (!raced) {
        raced = true;
        await duringEmbed();
      }
      return emb;
    });
    return { restore: () => spy.mockRestore() };
  };

  it("REFUSES INSIDE THE WRITE TRANSACTION when the parent is disputed after the preflight passed", async () => {
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation.");
    const race = raceOnEmbed(c, () => {
      c.flagContradiction(principle, { kind: "impeachment", detail: "a sibling rule was corrected mid-write" });
    });

    await expect(c.store("Confirm the target namespace before deleting a release.", {
      kind: "rule",
      rule: { stage: "helm delete", instance: "Bash:helm delete my-release", scope: "domain", projectedFromPrincipleId: principle },
    })).rejects.toThrow(/is 'disputed', not active: a contested or retired principle governs nothing/);

    // NOTHING LANDED. The refusal is the same named error the preflight raises, and the transaction
    // took the rule concept, its binding and its stage down with it.
    expect(raw(c).prepare(`SELECT COUNT(*) AS n FROM lifecycle_edges WHERE family='derivation'`).get()).toMatchObject({ n: 0 });
    expect(c.stages().some((s) => s.name === "helm delete")).toBe(false);
    expect(raw(c).prepare(`SELECT COUNT(*) AS n FROM concepts WHERE kind='rule'`).get()).toMatchObject({ n: 0 });
    race.restore();
    c.close();
  });

  it("REFUSES INSIDE THE WRITE TRANSACTION when the parent is RETIRED BY VERDICT after the preflight passed", async () => {
    // The status checks are not the whole guard: a `retire` ratification leaves the concept `active`
    // and kind `principle`, so only the latest-ratification read catches it. That read has to run
    // inside the transaction too, or a retire landing during the await projects from a principle the
    // human just ended.
    const c = core();
    const principle = await principleOf(c, "Irreversible acts get a confirmation.");
    const race = raceOnEmbed(c, async () => {
      await c.ratify({ candidateId: principle, verdict: "retire", ratifiedBy: "john" });
    });

    await expect(c.store("Confirm the target namespace before deleting a release.", {
      kind: "rule",
      rule: { stage: "helm delete", instance: "Bash:helm delete my-release", scope: "domain", projectedFromPrincipleId: principle },
    })).rejects.toThrow(/is not a current skeleton member \(latest verdict 'retire'\)/);
    expect(raw(c).prepare(`SELECT COUNT(*) AS n FROM lifecycle_edges WHERE family='derivation'`).get()).toMatchObject({ n: 0 });
    race.restore();
    c.close();
  });
});

describe("5-B: extraction-candidate flagging", () => {
  /**
   * THE AMBIGUOUS BAND, the same fixture shape overview-possible-duplicates.test.ts uses: the
   * extraction flag rides the near-match a FORK produces, so a store must land between
   * tauAmbiguous and tauAttach. Dedup-disabled (`core()`) would never produce a near-match at all,
   * and shipping thresholds would ATTACH two rules that restate one reason into one concept —
   * neither state is what "a rule born near another rule" means.
   *
   * tauAttach 0.99 rather than that file's 0.9, measured rather than guessed: the closest pair
   * below embeds at ~0.904, which 0.9 would ATTACH — the band has to be wide enough for the whole
   * fixture set, and this suite's own subject is what the fork does afterwards, not where the
   * boundary sits (resolution.ts's unit tests own that).
   */
  const bandCore = (): MonetCore => new MonetCore(":memory:", { tauAttach: 0.99, tauAmbiguous: 0.1 });

  const ruleAt = (c: MonetCore, text: string, stage: string, instance: string, extra: Record<string, unknown> = {}) =>
    c.store(text, { kind: "rule", rule: { stage, instance, scope: "domain", ...extra } });

  /** The PAIR FLAGS between two concepts — the ordinary derived graph (related/co_occurred/follows)
   *  is not this suite's subject and would only make the assertions brittle to edge derivation. */
  const edgeTypesBetween = (c: MonetCore, a: string, b: string): string[] =>
    (raw(c).prepare(
      `SELECT DISTINCT type FROM memory_edge
        WHERE type IN ('possible_duplicate_of','extraction_candidate')
          AND ((src_id=? AND dst_id=?) OR (src_id=? AND dst_id=?)) ORDER BY type`,
    ).all(a, b, b, a) as Array<{ type: string }>).map((r) => r.type);

  it("flags a pair of near-matching rules bound to DIFFERENT stages — the breadth precondition, at rule birth", async () => {
    const c = bandCore();
    const first = await ruleAt(c, "Verify the built artifact after the source changes.", "docker build", "Bash:docker build .");
    const second = await ruleAt(c, "After the source changes, verify the artifact itself.", "npm install", "Bash:npm install");

    expect(second.action).toBe("ambiguous"); // forked, so this really is a rule BIRTH
    expect(second.extractionCandidate).toEqual({ pairedRuleId: first.conceptId, score: second.nearMatchScore });
    expect(edgeTypesBetween(c, first.conceptId, second.conceptId)).toEqual(["extraction_candidate", "possible_duplicate_of"]);

    // BOTH QUESTIONS ARE OPEN ABOUT THIS PAIR, and each gets its own curation line: "are these one
    // thing?" (detach) and "do these share a reason?" (the battery, then memory_ratify).
    const o = c.overview("default");
    expect(o.counts.extractionCandidates).toBe(1);
    expect(o.extractionCandidates).toHaveLength(1);
    expect([o.extractionCandidates[0]!.conceptAId, o.extractionCandidates[0]!.conceptBId].sort())
      .toEqual([first.conceptId, second.conceptId].sort());
    expect(o.extractionCandidates[0]!.score).toBeCloseTo(second.nearMatchScore!, 6);
    expect(o.counts.possibleDuplicates).toBe(1);
    // NO PRINCIPLE WAS CREATED, and no battery ran. The flag is the whole deliverable.
    expect(c.skeleton("default")).toEqual([]);

    // THE DECLARATION ENTRANCE FLAGS IDENTICALLY: the breadth precondition does not care which door
    // a rule came through — two rules at different stages restating one reason are extraction
    // evidence whether a correction or a human put them there.
    const declared = await c.declare({
      species: "rule", stage: "kubectl apply", instance: "Bash:kubectl apply -f x", scope: "domain",
      content: "Verify the artifact that was built once the source changes.",
    });
    if (declared.species !== "rule") throw new Error("unreachable");
    expect(declared.extractionCandidate).toMatchObject({ pairedRuleId: expect.any(String) });
    c.close();
  });

  /**
   * THE CONDITION IS LIVE, NOT FROZEN AT FLAG TIME (review fix — Codex 5-B round 2, R2-4). The edge
   * records that two rules at different stages near-matched; a later re-declaration can move either
   * binding, and once both rules sit at ONE stage the pair no longer satisfies the defining
   * condition. The stored edge is undismissed and the overview queries joined only the CONCEPTS, so
   * memory_overview kept reporting a pair that had stopped being one.
   *
   * READ-SIDE, deliberately — the edge row is not retired. It is history (this pair really did
   * near-match at that birth), the dismissal machinery still covers it, and a binding can move back.
   * The report is what must not lie; see `getExtractionCandidatePairs` for the same note at the SQL.
   */
  it("stops reporting a pair once a re-declaration puts both rules at ONE stage — and reports it again when the binding moves back", async () => {
    const c = bandCore();
    const first = await ruleAt(c, "Verify the built artifact after the source changes.", "docker build", "Bash:docker build .");
    const second = await ruleAt(c, "After the source changes, verify the artifact itself.", "npm install", "Bash:npm install");
    expect(second.extractionCandidate).toMatchObject({ pairedRuleId: first.conceptId });
    expect(c.overview("default").counts.extractionCandidates).toBe(1);

    // THE MOVE. A sovereign re-declaration is the one act that re-addresses a live rule, and it
    // lands `second` on `first`'s stage — so the breadth precondition ("member rules from ≥2
    // stages") is now false for this pair.
    const moved = await c.declare({
      species: "rule", stage: "docker build", scope: "domain",
      content: "After the source changes, verify the artifact itself.",
    });
    if (moved.species !== "rule") throw new Error("unreachable");
    expect(moved.conceptId).toBe(second.conceptId); // re-declared the SAME rule, not a new one
    expect(c.ruleBinding(second.conceptId)!.stage_id).toBe(c.ruleBinding(first.conceptId)!.stage_id);

    // THE EDGE SURVIVES — it is history, and the pair is one re-declaration away from qualifying
    // again — but neither the list nor the count claims the question is still open.
    expect(edgeTypesBetween(c, first.conceptId, second.conceptId)).toContain("extraction_candidate");
    const hidden = c.overview("default");
    expect(hidden.counts.extractionCandidates).toBe(0);
    expect(hidden.extractionCandidates).toEqual([]);

    // ...AND BACK. Nothing was dismissed, so restoring the different-stage condition restores the
    // report — which is exactly why retiring the edge would have been the wrong repair.
    const back = await c.declare({
      species: "rule", stage: "npm install", scope: "domain",
      content: "After the source changes, verify the artifact itself.",
    });
    if (back.species !== "rule") throw new Error("unreachable");
    expect(back.conceptId).toBe(second.conceptId);
    const restored = c.overview("default");
    expect(restored.counts.extractionCandidates).toBe(1);
    expect([restored.extractionCandidates[0]!.conceptAId, restored.extractionCandidates[0]!.conceptBId].sort())
      .toEqual([first.conceptId, second.conceptId].sort());
    c.close();
  });

  it("stops reporting a pair while either endpoint is disputed, then restores it after mediation", async () => {
    const c = bandCore();
    const first = await ruleAt(c, "Verify the built artifact after the source changes.", "docker build", "Bash:docker build .");
    const second = await ruleAt(c, "After the source changes, verify the artifact itself.", "npm install", "Bash:npm install");
    expect(second.extractionCandidate).toMatchObject({ pairedRuleId: first.conceptId });
    expect(c.overview("default").counts.extractionCandidates).toBe(1);

    // Rules reject flagContradiction directly, but detach can carry an already-open dispute onto an
    // advisory rule while preserving that rule's pair-flag edges. Exercise that supported route.
    const disputedEvidence = await c.store("A separate evidence packet is internally contested.", {
      kind: "fact", resolution: "forceNew",
    });
    const correctionEvidence = await c.store("That evidence packet has a conflicting interpretation.", {
      kind: "correction", attachTo: disputedEvidence.conceptId,
    });
    c.flagContradiction(disputedEvidence.conceptId, {
      observationId: correctionEvidence.observationId, kind: "value-conflict", detail: "the evidence is contested",
    });
    await c.detach(disputedEvidence.conceptId, [
      (await c.getConcept(disputedEvidence.conceptId, { synthesize: false }))!.observations[0]!.id,
      correctionEvidence.observationId,
    ], {
      destConceptId: first.conceptId,
    });
    expect((await c.getConcept(first.conceptId))!.status).toBe("disputed");
    const hidden = c.overview("default");
    expect(hidden.extractionCandidates).toEqual([]);
    expect(hidden.counts.extractionCandidates).toBe(0);

    const movedContradictions = raw(c).prepare(
      `SELECT id FROM contradictions WHERE concept_id = ? AND status = 'open'`,
    ).all(first.conceptId) as Array<{ id: string }>;
    expect(movedContradictions.length).toBeGreaterThan(0);
    for (const moved of movedContradictions) {
      c.resolveContradiction(moved.id, { decision: "dismiss", by: "john" });
    }
    expect((await c.getConcept(first.conceptId))!.status).toBe("active");
    expect((await c.getConcept(second.conceptId))!.status).toBe("active");
    expect(edgeTypesBetween(c, first.conceptId, second.conceptId)).toContain("extraction_candidate");
    expect(c.ruleBinding(first.conceptId)!.stage_id).not.toBe(c.ruleBinding(second.conceptId)!.stage_id);
    const restored = c.overview("default");
    expect(restored.extractionCandidates).toHaveLength(1);
    expect(restored.counts.extractionCandidates).toBe(1);
    c.close();
  });

  it("refuses to flag a new pair when the near-match rule is already disputed", async () => {
    const c = bandCore();
    const first = await ruleAt(c, "Verify the built artifact after the source changes.", "docker build", "Bash:docker build .");
    const disputedEvidence = await c.store("A separate evidence packet is internally contested.", {
      kind: "fact", resolution: "forceNew",
    });
    const correctionEvidence = await c.store("That evidence packet has a conflicting interpretation.", {
      kind: "correction", attachTo: disputedEvidence.conceptId,
    });
    c.flagContradiction(disputedEvidence.conceptId, {
      observationId: correctionEvidence.observationId, kind: "value-conflict", detail: "the evidence is contested",
    });
    await c.detach(disputedEvidence.conceptId, [
      (await c.getConcept(disputedEvidence.conceptId, { synthesize: false }))!.observations[0]!.id,
      correctionEvidence.observationId,
    ], {
      destConceptId: first.conceptId,
    });
    expect((await c.getConcept(first.conceptId))!.status).toBe("disputed");
    const second = await ruleAt(c, "After the source changes, verify the artifact itself.", "npm install", "Bash:npm install");
    expect(second.nearMatchId).toBe(first.conceptId);
    expect(second.extractionCandidate).toBeUndefined();
    expect(c.overview("default").counts.extractionCandidates).toBe(0);
    c.close();
  });

  it("does NOT flag two rules at the SAME stage — that is a duplicate or a supersession, not breadth", async () => {
    const c = bandCore();
    const first = await ruleAt(c, "Verify the built artifact after the source changes.", "docker build", "Bash:docker build .");
    const second = await ruleAt(c, "After the source changes, verify the artifact itself.", "docker build", "Bash:docker build .");
    expect(second.action).toBe("ambiguous");
    expect(second.extractionCandidate).toBeUndefined();
    expect(edgeTypesBetween(c, first.conceptId, second.conceptId)).toEqual(["possible_duplicate_of"]);
    expect(c.overview("default").counts.extractionCandidates).toBe(0);
    c.close();
  });

  it("does NOT flag when EITHER side is projection-born — a principle must not manufacture its own support", async () => {
    const c = bandCore();
    const declared = await c.declare({ species: "principle", content: "A build artifact is a snapshot; re-materialize after the source changes." });
    if (declared.species !== "principle") throw new Error("unreachable");
    const principle = declared.conceptId;

    // (1) THE OLD SIDE is projection-born.
    const projected = await ruleAt(c, "Verify the built artifact after the source changes.", "docker build", "Bash:docker build .", {
      projectedFromPrincipleId: principle,
    });
    const fresh = await ruleAt(c, "After the source changes, verify the artifact itself.", "npm install", "Bash:npm install");
    expect(fresh.nearMatchId).toBe(projected.conceptId); // the near-match really did happen
    expect(fresh.extractionCandidate).toBeUndefined();

    // (2) THE NEW SIDE is projection-born — checked separately, because "excluded from extraction
    //     evidence" is a property of the rule, not of which end of the pair it lands on.
    const newProjection = await ruleAt(c, "Once the source has changed, verify what was built.", "terraform apply", "Bash:terraform apply", {
      projectedFromPrincipleId: principle,
    });
    expect(newProjection.nearMatchId).toBeTruthy();
    expect(newProjection.extractionCandidate).toBeUndefined();
    expect(c.overview("default").counts.extractionCandidates).toBe(0);
    c.close();
  });

  /**
   * PROJECTION-BORNNESS IS LIVE TOO (review fix — Codex 5-B round 3, R3-2), and this is the read-side
   * twin of the write-side refusal just above. `flagExtractionCandidate` judges both endpoints at
   * rule BIRTH, but a rule becomes projection-born LATER whenever a projection attaches to it —
   * `recordProjectionEdge` is deliberately reachable on the attach path ("a projected rule ... IS A
   * CACHE HIT next firing"), and a graft can land the same edge. The overview and its count rechecked
   * only the stages, so a pair flagged while both rules were ordinary kept asking a human to run the
   * battery on evidence the principle had since manufactured for itself.
   *
   * READ-SIDE, for the same reason R2-4's different-stage test is: the edge is an honest record of a
   * near-match that really happened, the dismissal machinery still covers it, and the report is what
   * must not lie.
   *
   * BOTH ENDPOINTS, EXHAUSTIVELY RATHER THAN BY LUCK. The stored pair is read `src_id < dst_id`, so
   * one rule fills the query's `ca` slot and the other its `cb` — and which one is decided by how two
   * uuids happen to sort. Projecting onto "the first rule stored" would therefore have exercised a
   * RANDOM one of the two NOT EXISTS clauses (both draws landed on `ca` when this was written), so
   * the target is chosen by ROLE after both ids exist: one store per side, both clauses covered every
   * run.
   */
  it("stops reporting a pair once EITHER rule becomes projection-born — checked at read time, on both endpoints", async () => {
    const specs = [
      { text: "Verify the built artifact after the source changes.", stage: "docker build", instance: "Bash:docker build ." },
      { text: "After the source changes, verify the artifact itself.", stage: "npm install", instance: "Bash:npm install" },
    ] as const;

    /** Flag an ordinary cross-stage pair, then project onto whichever rule fills `role`. */
    const projectOntoEndpoint = async (role: "ca" | "cb"): Promise<void> => {
      const c = bandCore();
      const first = await ruleAt(c, specs[0].text, specs[0].stage, specs[0].instance);
      const second = await ruleAt(c, specs[1].text, specs[1].stage, specs[1].instance);
      // THE PREMISE: an ORDINARY pair — neither rule is projection-born, so it is flagged and shown.
      expect(second.extractionCandidate).toMatchObject({ pairedRuleId: first.conceptId });
      expect(c.overview("default").counts.extractionCandidates).toBe(1);

      const declared = await c.declare({
        species: "principle",
        content: "A build artifact is a snapshot; re-materialize after the source changes.",
      });
      if (declared.species !== "principle") throw new Error("unreachable");

      // `ca` is the LOWER id, `cb` the higher — see this test's own doc comment.
      const born = [{ id: first.conceptId, spec: specs[0] }, { id: second.conceptId, spec: specs[1] }]
        .sort((x, y) => (x.id < y.id ? -1 : 1));
      const target = role === "ca" ? born[0]! : born[1]!;

      // THE LATER PROJECTION. Not a new rule: the same text resolves onto the rule that is already
      // there, and `recordProjectionEdge` writes the derivation edge onto that existing concept —
      // which is exactly how an already-flagged rule becomes projection-born after the fact.
      const projection = await c.store(target.spec.text, {
        kind: "rule",
        rule: {
          stage: target.spec.stage, instance: target.spec.instance, scope: "domain",
          projectedFromPrincipleId: declared.conceptId,
        },
      });
      expect(projection.action).toBe("attached");
      expect(projection.conceptId).toBe(target.id);
      expect(raw(c).prepare(
        `SELECT born_of FROM lifecycle_edges WHERE family='derivation' AND src_concept_id=? AND dst_concept_id=?`,
      ).get(declared.conceptId, target.id)).toMatchObject({ born_of: "projection" });
      // The pair's OTHER precondition is untouched: a re-capture keeps the incumbent binding, so the
      // two rules still sit at different stages and projection-bornness is the only thing that moved.
      expect(c.ruleBinding(first.conceptId)!.stage_id).not.toBe(c.ruleBinding(second.conceptId)!.stage_id);

      // NEITHER THE LIST NOR THE COUNT still claims this is open evidence.
      const after = c.overview("default");
      expect(after.counts.extractionCandidates).toBe(0);
      expect(after.extractionCandidates).toEqual([]);

      // THE EDGE SURVIVES as history, and the dismissal exit still reaches it.
      expect(edgeTypesBetween(c, first.conceptId, second.conceptId)).toContain("extraction_candidate");
      expect(c.dismissPossibleDuplicate(first.conceptId, second.conceptId, "john"))
        .toMatchObject({ dismissed: true, rowsUpdated: 4 });
      c.close();
    };

    await projectOntoEndpoint("ca");
    await projectOntoEndpoint("cb");
  });

  /**
   * FORCE-NEW BIRTHS FLAG TOO (review fix — Codex 5-B round 4, R4-3). The force-new branch never
   * assigned `nearMatchId`/`nearMatchScore` — it makes no pairing decision, which is the whole point
   * of the mode — so the flagging condition, gated on those two fields, could not run on that path
   * at all. Bulk and import callers therefore lost every extraction candidate that an automatic or a
   * declared birth reports, silently.
   *
   * THE TWO QUESTIONS ARE NOT THE SAME QUESTION, and only one of them is force-new's to answer:
   * "are these one thing?" (distinctness — asserted by the caller, and still asserted here: no
   * `possible_duplicate_of` edge is written, which the assertion below pins) versus "do these share
   * one reason?" (breadth — the battery's question, which distinctness says nothing about). An
   * import of one team's rules is if anything the richest source of cross-stage repetition there is.
   *
   * FORCE-NEW BYPASSES THE BAND ENTIRELY (no nomination is even scanned), so this test's fixture
   * core is the block's only for consistency — the near-match here is the centroid neighbour that
   * force-new's own informational `score` has always reported.
   */
  it("flags a FORCE-NEW rule birth against its cross-stage nearest neighbour — distinctness is not the extraction question", async () => {
    const c = bandCore();
    const first = await ruleAt(c, "Verify the built artifact after the source changes.", "docker build", "Bash:docker build .");
    const opts = {
      kind: "rule", resolution: "forceNew" as const, operationId: "bulk-import-1",
      rule: { stage: "npm install", instance: "Bash:npm install", scope: "domain" as const },
    };
    const forced = await c.store("After the source changes, verify the artifact itself.", opts);

    expect(forced.action).toBe("created");
    expect(forced.resolutionMode).toBe("force-new");
    expect(forced.conceptId).not.toBe(first.conceptId);
    // THE FLAG THE PATH USED TO LOSE — reported on the response exactly as the automatic path
    // reports it, at force-new's own nearest-neighbour score.
    expect(forced.extractionCandidate).toEqual({ pairedRuleId: first.conceptId, score: forced.score });
    expect(forced.score).toBeGreaterThan(0);
    // DISTINCTNESS IS STILL ASSERTED: an extraction candidate, and NOT a possible duplicate. The
    // caller said these are two things and nothing here second-guesses that.
    expect(edgeTypesBetween(c, first.conceptId, forced.conceptId)).toEqual(["extraction_candidate"]);
    const o = c.overview("default");
    expect(o.counts.extractionCandidates).toBe(1);
    expect(o.counts.possibleDuplicates).toBe(0);

    // AN IDEMPOTENT REPLAY IS INDISTINGUISHABLE FROM THE FIRST CALL, which is why the pair is frozen
    // onto the receipt: `replayRuleOutcome` rebuilds this field from the receipt's near_match_id and
    // the edge's existence, and a receipt with no near match could not rebuild it at all.
    const replay = await c.store("After the source changes, verify the artifact itself.", opts);
    expect(replay.conceptId).toBe(forced.conceptId);
    expect(replay.extractionCandidate).toEqual(forced.extractionCandidate);
    expect(c.overview("default").counts.extractionCandidates).toBe(1); // the replay wrote nothing new
    c.close();
  });

  it("does NOT flag a FORCE-NEW rule birth against a SAME-stage neighbour — the qualifiers are unchanged", async () => {
    const c = bandCore();
    const first = await ruleAt(c, "Verify the built artifact after the source changes.", "docker build", "Bash:docker build .");
    const forced = await c.store("After the source changes, verify the artifact itself.", {
      kind: "rule", resolution: "forceNew",
      rule: { stage: "docker build", instance: "Bash:docker build .", scope: "domain" },
    });
    expect(forced.action).toBe("created");
    expect(forced.conceptId).not.toBe(first.conceptId);
    expect(forced.extractionCandidate).toBeUndefined();
    // No flag means no relation, so the neighbour is not named either — force-new's response is
    // unchanged on every write that did not earn an edge.
    expect(forced.nearMatchId).toBeUndefined();
    expect(edgeTypesBetween(c, first.conceptId, forced.conceptId)).toEqual([]);
    expect(c.overview("default").counts.extractionCandidates).toBe(0);
    c.close();
  });

  /**
   * THE FORCE-NEW FEED HAS THE AUTO PATH'S FLOOR (review fix — Codex 5-B round 5, R5-3). Every
   * automatic `nearMatchId` is >= tauAmbiguous by construction (the decision table's
   * nearMatch-bearing modes all sit inside the band; mode "new" carries none), but `liveMatches[0]`
   * is the raw centroid ranking, where any positive cosine appears — so an unfloored force-new
   * import in a populated circle would flag near-noise pairs. tauAmbiguous is cranked ABOVE any
   * realistic neighbour score here, so the floor — not text luck — is what this test exercises;
   * the flags-a-FORCE-NEW test above (band floor 0.1, similar texts) stays the >= case.
   */
  it("does NOT flag a FORCE-NEW rule birth whose nearest neighbour is below tauAmbiguous — the floor is the band's", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 0.99, tauAmbiguous: 0.95 });
    const first = await ruleAt(c, "Verify the built artifact after the source changes.", "docker build", "Bash:docker build .");
    const forced = await c.store("After the source changes, verify the artifact itself.", {
      kind: "rule", resolution: "forceNew",
      rule: { stage: "npm install", instance: "Bash:npm install", scope: "domain" },
    });
    expect(forced.action).toBe("created");
    expect(forced.conceptId).not.toBe(first.conceptId);
    // Cross-stage, both bound, neither projection-born — every qualifier holds; ONLY the score is
    // below the band, and that alone keeps the flag (and therefore the frozen pair) off the write.
    expect(forced.extractionCandidate).toBeUndefined();
    expect(forced.nearMatchId).toBeUndefined();
    expect(edgeTypesBetween(c, first.conceptId, forced.conceptId)).toEqual([]);
    expect(c.overview("default").counts.extractionCandidates).toBe(0);
    c.close();
  });

  /**
   * A SUPERSEDED NEIGHBOUR CANNOT EVIDENCE BREADTH (review fix — Codex 5-B round 5, R5-1, write
   * side). A superseded rule deliberately keeps `status='active'` and its binding — it is history —
   * so resolution can still nominate it; but the gate stopped delivering it, and a battery run over
   * a rule no gate fires is a principle proposed over dead evidence.
   */
  it("does NOT flag a birth against a SUPERSEDED rule — active status is not gate liveness", async () => {
    const c = bandCore();
    const first = await ruleAt(c, "Verify the built artifact after the source changes.", "docker build", "Bash:docker build .");
    // Overturn it: the correction births its successor at the same gate and supersedes it in one act.
    const overturn = await c.store("Skip verification entirely on throwaway spike branches.", {
      kind: "correction", attachTo: first.conceptId,
    });
    expect(overturn.ruleSuccession?.supersededRuleId).toBe(first.conceptId);
    // THE PREMISE the fix exists for: the superseded rule is still active and still bound.
    expect((await c.getConcept(first.conceptId))!.status).toBe("active");
    expect(c.ruleBinding(first.conceptId)).not.toBeNull();

    // A cross-stage birth whose nearest is the SUPERSEDED incumbent (its text, not the successor's).
    const probe = await ruleAt(c, "After the source changes, verify the artifact itself.", "npm install", "Bash:npm install");
    expect(probe.nearMatchId).toBe(first.conceptId);
    expect(probe.extractionCandidate).toBeUndefined();
    // NO extraction flag. The possible_duplicate_of pair the ambiguous-fork records is untouched —
    // "are these one thing?" is still a fair question about a superseded rule; breadth is not.
    expect(edgeTypesBetween(c, first.conceptId, probe.conceptId)).not.toContain("extraction_candidate");
    expect(c.overview("default").counts.extractionCandidates).toBe(0);
    c.close();
  });

  /**
   * AND THE SAME CONDITION HOLDS AT READ TIME (R5-1, read side), like the block's other two
   * after-the-fact conditions (stage move, later projection): a pair flagged while both rules were
   * live stops being reported the moment either one is overturned — the edge stays (history, and a
   * dismissal can still answer it), the REPORT is what must not lie.
   */
  it("stops reporting a pair once EITHER rule is superseded — checked at read time, edge and dismissal intact", async () => {
    const c = bandCore();
    const first = await ruleAt(c, "Verify the built artifact after the source changes.", "docker build", "Bash:docker build .");
    const second = await ruleAt(c, "After the source changes, verify the artifact itself.", "npm install", "Bash:npm install");
    expect(second.extractionCandidate).toMatchObject({ pairedRuleId: first.conceptId });
    expect(c.overview("default").counts.extractionCandidates).toBe(1);

    // Overturn ONE endpoint through the ordinary correction path, so succeedRule records the act.
    const overturn = await c.store("Skip artifact verification entirely on spike branches.", {
      kind: "correction", attachTo: second.conceptId,
    });
    expect(overturn.ruleSuccession?.supersededRuleId).toBe(second.conceptId);

    const after = c.overview("default");
    expect(after.counts.extractionCandidates).toBe(0);
    expect(after.extractionCandidates).toEqual([]);
    // The edge survives as history, and the dismissal exit still reaches all four rows.
    expect(edgeTypesBetween(c, first.conceptId, second.conceptId)).toContain("extraction_candidate");
    expect(c.dismissPossibleDuplicate(first.conceptId, second.conceptId, "john"))
      .toMatchObject({ dismissed: true, rowsUpdated: 4 });
    c.close();
  });

  it("does NOT flag a near-match that is not a bound rule, and does not flag on an ATTACH", async () => {
    const c = bandCore();
    // A FACT the rule paraphrases: the possible-duplicate machinery's business, not extraction's.
    const fact = await c.store("The build artifact is a snapshot of the source at build time.");
    const rule = await ruleAt(c, "A built artifact is a snapshot of its source at build time.", "docker build", "Bash:docker build .");
    expect(rule.nearMatchId).toBe(fact.conceptId);
    expect(rule.extractionCandidate).toBeUndefined();

    // ATTACH is not a birth: evidence absorbed into an existing rule flags nothing.
    const attached = await c.store("More evidence for the same rule.", { kind: "rule", attachTo: rule.conceptId, rule: { stage: "docker build", scope: "domain" } });
    expect(attached.action).toBe("attached");
    expect(attached.extractionCandidate).toBeUndefined();
    expect(c.overview("default").counts.extractionCandidates).toBe(0);
    c.close();
  });

  it("dismisses an extraction candidate through the SAME pair-dismissal path duplicates use", async () => {
    const c = bandCore();
    const first = await ruleAt(c, "Verify the built artifact after the source changes.", "docker build", "Bash:docker build .");
    const second = await ruleAt(c, "After the source changes, verify the artifact itself.", "npm install", "Bash:npm install");
    expect(c.overview("default").counts.extractionCandidates).toBe(1);

    // Widened from possible_duplicate_of alone in 5-B: without this, the flag had no exit, and
    // "every process element must carry the mechanism of its own death."
    const r = c.dismissPossibleDuplicate(first.conceptId, second.conceptId, "john");
    expect(r).toMatchObject({ dismissed: true, rowsUpdated: 4 }); // both types, both directions
    const after = c.overview("default");
    expect(after.counts.extractionCandidates).toBe(0);
    expect(after.extractionCandidates).toEqual([]);
    expect(after.counts.possibleDuplicates).toBe(0);
    // Idempotent, exactly as the duplicate path already is.
    expect(c.dismissPossibleDuplicate(first.conceptId, second.conceptId, "john")).toMatchObject({ dismissed: true, rowsUpdated: 0 });
    c.close();
  });

  it("survives a detach/rederive cycle with its dismissal intact — pair flags are snapshotted, not re-derived", async () => {
    const c = bandCore();
    const first = await ruleAt(c, "Verify the built artifact after the source changes.", "docker build", "Bash:docker build .");
    const second = await ruleAt(c, "After the source changes, verify the artifact itself.", "npm install", "Bash:npm install");
    const third = await ruleAt(c, "Check the deployed bundle after a source change.", "kubectl apply", "Bash:kubectl apply -f x");
    expect(c.overview("default").counts.extractionCandidates).toBeGreaterThanOrEqual(2);
    c.dismissPossibleDuplicate(first.conceptId, second.conceptId, "john");

    // Detach `third`'s evidence into a NEW concept: unwinds and re-derives third's graph footprint,
    // which erases every edge touching it. Without the snapshot carve-out, its extraction pairs
    // would silently vanish; without carrying dismissed_at, the dismissed pair would come back.
    const fetched = (await c.getConcept(third.conceptId, { synthesize: false }))!;
    await c.store("A second observation so the detach leaves live evidence behind.", { attachTo: third.conceptId });
    await c.detach(third.conceptId, [fetched.observations[0]!.id], {});

    const after = c.overview("default");
    const pairIds = after.extractionCandidates.map((p) => [p.conceptAId, p.conceptBId].sort().join("|"));
    expect(pairIds).not.toContain([first.conceptId, second.conceptId].sort().join("|")); // still dismissed
    expect(raw(c).prepare(
      `SELECT COUNT(*) AS n FROM memory_edge WHERE type='extraction_candidate' AND (src_id=? OR dst_id=?)`,
    ).get(third.conceptId, third.conceptId)).toMatchObject({ n: 2 }); // survived the unwind, both directions
    c.close();
  });

  it("renders as its own curation heading, not folded into possible duplicates", async () => {
    const c = bandCore();
    await ruleAt(c, "Verify the built artifact after the source changes.", "docker build", "Bash:docker build .");
    await ruleAt(c, "After the source changes, verify the artifact itself.", "npm install", "Bash:npm install");
    const rendered = renderOverview(c.overview("default"), { color: false, width: 200 });
    expect(rendered).toContain("EXTRACTION CANDIDATES");
    expect(rendered).toContain("rules at different stages that may share one reason");
    c.close();
  });

  /**
   * THE FLAG'S ADVERTISED SUCCESSFUL EXIT (review fix — Codex 5-B round 4, R4-4). memory_overview's
   * own guidance says an extraction candidate is answered by "a conversation ending in memory_ratify,
   * not a merge" — and until this fix, completing exactly that conversation left the flag open. The
   * overview went on prompting the same battery a human had just finished, and the only way to clear
   * it was pair dismissal, which asserts the two rules are UNRELATED and therefore contradicts the
   * ratification that had just related them.
   *
   * Both answers land as a dismissal because both ANSWER the pair's question — see
   * `flagExtractionCandidate`'s own "two answer shapes, one exit" note at the mint site. What
   * distinguishes them afterwards is the surrounding record: derivation edges from a principle to
   * both rules, or none.
   */
  const principleFor = async (c: MonetCore, content: string): Promise<string> => {
    const r = await c.declare({ species: "principle", content, declaredBy: "john" });
    if (r.species !== "principle") throw new Error("unreachable");
    return r.conceptId;
  };

  /** Both stored directions of the pair flag, which is how `upsertEdgeBoth` writes it. */
  const extractionEdgeRows = (c: MonetCore, a: string, b: string): Array<{ dismissed_at: number | null; dismissed_by: string | null }> =>
    raw(c).prepare(
      `SELECT dismissed_at, dismissed_by FROM memory_edge
        WHERE type='extraction_candidate' AND ((src_id=? AND dst_id=?) OR (src_id=? AND dst_id=?))`,
    ).all(a, b, b, a) as Array<{ dismissed_at: number | null; dismissed_by: string | null }>;

  it("a ratification naming BOTH rules of a flagged pair resolves the flag, stamped with the ratifier", async () => {
    const c = bandCore();
    const first = await ruleAt(c, "Verify the built artifact after the source changes.", "docker build", "Bash:docker build .");
    const second = await ruleAt(c, "After the source changes, verify the artifact itself.", "npm install", "Bash:npm install");
    expect(c.overview("default").counts.extractionCandidates).toBe(1);
    const principle = await principleFor(c, "A build artifact is a snapshot; re-materialize after the source changes.");

    // THE HUMAN COMPLETES THE ADVERTISED PATH: the battery ran in conversation, and this is the
    // ruling on it — both rules named as evidence that the principle generates them.
    const ratified = await c.ratify({
      candidateId: principle, verdict: "approve", memberRuleIds: [first.conceptId, second.conceptId], ratifiedBy: "john",
    });
    expect(ratified.edgeIds).toHaveLength(2);
    expect(ratified.extractionFlagsResolved).toBe(1); // PAIRS, not rows

    // THE BATTERY IS NO LONGER PROMPTED, and the count agrees with the list.
    const after = c.overview("default");
    expect(after.counts.extractionCandidates).toBe(0);
    expect(after.extractionCandidates).toEqual([]);

    // THE DISMISSAL COLUMNS ARE THE EXISTING ONES, stamped with WHO ruled — both stored directions.
    const rows = extractionEdgeRows(c, first.conceptId, second.conceptId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.dismissed_by).toBe("john");
      expect(row.dismissed_at).toBeGreaterThan(0);
    }

    // AND THE OTHER QUESTION IS UNTOUCHED. "Do these share a reason?" was answered; "are these one
    // thing?" was not, and two rules a principle derives are emphatically not one concept — so this
    // is narrower than `dismissPossibleDuplicate`, which retires every pair flag between two ids at
    // once. THIS pair is asserted by id rather than by the circle's total, because declaring the
    // principle forks against a near-matching rule and pairs with it, which is a different pair.
    const stillDuplicates = after.possibleDuplicates
      .map((p) => [p.conceptAId, p.conceptBId].sort().join("|"));
    expect(stillDuplicates).toContain([first.conceptId, second.conceptId].sort().join("|"));
    c.close();
  });

  it("resolves EVERY flagged pair among three or more member rules, not just adjacent ones", async () => {
    const c = bandCore();
    const first = await ruleAt(c, "Verify the built artifact after the source changes.", "docker build", "Bash:docker build .");
    const second = await ruleAt(c, "After the source changes, verify the artifact itself.", "npm install", "Bash:npm install");
    const third = await ruleAt(c, "Check the deployed bundle after a source change.", "kubectl apply", "Bash:kubectl apply -f x");
    const open = c.overview("default").counts.extractionCandidates;
    expect(open).toBeGreaterThanOrEqual(2); // which births paired with which is the fixture's business
    const principle = await principleFor(c, "A build artifact is a snapshot; re-materialize after the source changes.");

    // MEMBER ORDER IS NOT PAIR ORDER: the ids are handed over in an order that puts the flagged
    // pairs at different distances apart, so an implementation that only compared neighbours would
    // leave one open here.
    const ratified = await c.ratify({
      candidateId: principle, verdict: "approve",
      memberRuleIds: [third.conceptId, first.conceptId, second.conceptId], ratifiedBy: "john",
    });
    expect(ratified.extractionFlagsResolved).toBe(open);
    const after = c.overview("default");
    expect(after.counts.extractionCandidates).toBe(0);
    expect(after.extractionCandidates).toEqual([]);
    c.close();
  });

  it("leaves the flag open when only ONE of the pair is named — half an answer is not an answer", async () => {
    const c = bandCore();
    const first = await ruleAt(c, "Verify the built artifact after the source changes.", "docker build", "Bash:docker build .");
    const second = await ruleAt(c, "After the source changes, verify the artifact itself.", "npm install", "Bash:npm install");
    const principle = await principleFor(c, "A build artifact is a snapshot; re-materialize after the source changes.");

    const ratified = await c.ratify({
      candidateId: principle, verdict: "approve", memberRuleIds: [first.conceptId], ratifiedBy: "john",
    });
    // Omitted rather than reported 0 — the same omit-when-absent shape `impeachmentsClosed` carries.
    expect(ratified.extractionFlagsResolved).toBeUndefined();
    expect(c.overview("default").counts.extractionCandidates).toBe(1);
    expect(extractionEdgeRows(c, first.conceptId, second.conceptId).every((r) => r.dismissed_at === null)).toBe(true);

    // A REJECT/RETIRE VERDICT RESOLVES NOTHING EITHER: memberRuleIds is ignored for those by
    // contract, so no derivation edge relates the pair and the pair's question stays open.
    const rejected = await c.ratify({
      candidateId: principle, verdict: "reject",
      memberRuleIds: [first.conceptId, second.conceptId], ratifiedBy: "john",
    });
    expect(rejected.extractionFlagsResolved).toBeUndefined();
    expect(c.overview("default").counts.extractionCandidates).toBe(1);
    c.close();
  });

  /**
   * ONE TRANSACTION FOR THE WHOLE VERDICT, extended to this third dependent write (review fix —
   * Codex 5-B round 4, R4-4, riding round 1's F4). A flag resolution that commits without its
   * verdict claims a human answered a question they did not; a verdict that commits without the
   * resolution is the state this fix exists to remove. Same fault-injection shape F4's own test uses.
   */
  it("resolves the flags inside the verdict's own transaction — an injected failure rolls the verdict back", async () => {
    const c = bandCore();
    const first = await ruleAt(c, "Verify the built artifact after the source changes.", "docker build", "Bash:docker build .");
    const second = await ruleAt(c, "After the source changes, verify the artifact itself.", "npm install", "Bash:npm install");
    const principle = await principleFor(c, "A build artifact is a snapshot; re-materialize after the source changes.");
    const verdictsBefore = c.getRatifications(principle).length;

    const db = (c as unknown as { db: StoragePort }).db;
    db.exec(`
      CREATE TRIGGER inject_extraction_flag_failure
      BEFORE UPDATE OF dismissed_at ON memory_edge
      WHEN NEW.dismissed_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'injected extraction-flag resolution failure');
      END;
    `);

    const ratify = () => c.ratify({
      candidateId: principle, verdict: "approve",
      memberRuleIds: [first.conceptId, second.conceptId], ratifiedBy: "john",
    });
    await expect(ratify()).rejects.toThrow(/injected extraction-flag resolution failure/);

    // ALL OR NOTHING: no verdict on record, no member edges, and the flag still open.
    expect(c.getRatifications(principle)).toHaveLength(verdictsBefore);
    expect(raw(c).prepare(
      `SELECT COUNT(*) AS n FROM lifecycle_edges WHERE family='derivation' AND src_concept_id=?`,
    ).get(principle)).toMatchObject({ n: 0 });
    expect(c.overview("default").counts.extractionCandidates).toBe(1);

    // HAPPY PATH UNCHANGED once the injected failure is gone — all three halves land together.
    db.exec(`DROP TRIGGER inject_extraction_flag_failure`);
    const ratified = await ratify();
    expect(ratified.extractionFlagsResolved).toBe(1);
    expect(ratified.edgeIds).toHaveLength(2);
    expect(c.getRatifications(principle)).toHaveLength(verdictsBefore + 1);
    expect(c.overview("default").counts.extractionCandidates).toBe(0);
    c.close();
  });
});

/**
 * THE STAGE FORK (review fix — Codex 5-B round 2, R2-6). "A rule repeating across stages is still a
 * rule": stage B deserves its own rule, and the pair is the strongest extraction evidence there is.
 *
 * The bug this closes is the STRONGEST case of D3 falling through the floor. An automatic rule
 * capture for stage B that scored ABOVE tauAttach against an incumbent bound to stage A attached:
 * `captureRuleBinding` kept the stage-A binding ("a rule's address does not move because an
 * incidental repeat named a different stage"), `landedOnExisting` went true, and the extraction
 * flag — gated on rule BIRTH — never ran. So stage B got no rule AND the pair got no candidate,
 * precisely when the evidence for breadth was at its most conclusive. The weaker, ambiguous-band
 * version of the same event flagged correctly all along, which is the tell.
 *
 * The repair is the SPECIES-FORK PRECEDENT one property over (PRs #106–#108): resolution nominated
 * the concept, not the caller, so a landing that would be wrong forks and pairs rather than failing
 * or absorbing. Mode "stage-fork", recorded in the store packet and in `resolution_events` exactly
 * as "species-fork" is, so `resolutionStats` counts it as the fork it is.
 */
describe("5-B: a rule repeating across stages forks instead of absorbing", () => {
  /** SHIPPING THRESHOLDS: identical text scores far above tauAttach, which is the case under test. */
  const ruleAt = (c: MonetCore, text: string, stage: string, instance: string, extra: Record<string, unknown> = {}) =>
    c.store(text, { kind: "rule", rule: { stage, instance, scope: "domain", ...extra } });
  const TEXT = "Verify the built artifact after the source changes.";

  it("forks a cross-stage rule capture, binds each rule to its own stage, and flags the extraction candidate", async () => {
    const c = resolvingCore();
    const first = await ruleAt(c, TEXT, "docker build", "Bash:docker build .");
    const second = await ruleAt(c, TEXT, "npm install", "Bash:npm install");

    // A FORK, not an attach — and it reports itself as one.
    expect(second.conceptId).not.toBe(first.conceptId);
    expect(second.action).toBe("created");
    expect(second.resolutionMode).toBe("stage-fork");
    expect(second.score).toBeGreaterThan(0.9); // it really was above tauAttach; nothing forked by weakness

    // BOTH RULES GOVERN THEIR OWN MOMENT. The incumbent's address never moved, and stage B — which
    // previously got nothing at all — now has a rule that actually fires there.
    const stageOf = (name: string) => c.stages().find((s) => s.name === name)!.id;
    expect(c.ruleBinding(first.conceptId)!.stage_id).toBe(stageOf("docker build"));
    expect(c.ruleBinding(second.conceptId)!.stage_id).toBe(stageOf("npm install"));
    expect(c.gate({ actionContext: "Bash:npm install" }).rules.map((r) => r.conceptId)).toEqual([second.conceptId]);
    expect(c.gate({ actionContext: "Bash:docker build ." }).rules.map((r) => r.conceptId)).toEqual([first.conceptId]);

    // ...AND THE PAIR IS EXTRACTION EVIDENCE, which is the whole reason the fork is worth having.
    expect(second.extractionCandidate).toMatchObject({ pairedRuleId: first.conceptId });
    const o = c.overview("default");
    expect(o.counts.extractionCandidates).toBe(1);
    expect([o.extractionCandidates[0]!.conceptAId, o.extractionCandidates[0]!.conceptBId].sort())
      .toEqual([first.conceptId, second.conceptId].sort());

    // COUNTED AS A FORK by the health signal, the same as species-fork — the mode is in
    // DECIDED_RESOLUTION_MODES, so it lands in the denominator too.
    const stats = c.resolutionStats("default");
    expect(stats.byMode.find((m) => m.mode === "stage-fork")).toMatchObject({ count: 1 });
    expect(stats.decidedTotal).toBe(2);
    c.close();
  });

  it("does NOT fork at the SAME stage — that is one rule gaining a second observation", async () => {
    const c = resolvingCore();
    const first = await ruleAt(c, TEXT, "docker build", "Bash:docker build .");
    const second = await ruleAt(c, TEXT, "docker build", "Bash:docker build .");
    expect(second.conceptId).toBe(first.conceptId);
    expect(second.action).toBe("attached");
    expect(second.resolutionMode).toBe("attach");
    expect(second.extractionCandidate).toBeUndefined();
    expect(c.overview("default").counts.extractionCandidates).toBe(0);
    c.close();
  });

  it("leaves an EXPLICIT attachTo alone — the caller asserted identity, so the incumbent address stands", async () => {
    const c = resolvingCore();
    const first = await ruleAt(c, TEXT, "docker build", "Bash:docker build .");
    const attached = await c.store(TEXT, {
      kind: "rule", attachTo: first.conceptId, rule: { stage: "npm install", scope: "domain" },
    });
    expect(attached.conceptId).toBe(first.conceptId);
    expect(attached.action).toBe("attached");
    expect(attached.resolutionMode).toBe("direct-attach");
    // Unchanged behavior, stated explicitly: the binding keeps its incumbent stage, and no stage is
    // created for the one the caller named — captureRuleBinding's "no stage for a binding that will
    // not use it" guard, untouched by this fix.
    expect(c.ruleBinding(first.conceptId)!.stage_id).toBe(c.stages().find((s) => s.name === "docker build")!.id);
    expect(c.stages().some((s) => s.name === "npm install")).toBe(false);
    c.close();
  });

  /**
   * A DECLARATION IS THE OTHER CALLER-ASSERTED CASE, and it must keep re-addressing. Declaration is
   * the ONLY act that may move a live rule's address (bindRule mode "replace"), and the sovereignty
   * boundary is the same one attachTo sits behind: a human naming both the rule and its new stage is
   * deciding, not repeating. Forking here would make "move this rule to that stage" unreachable.
   */
  it("leaves a DECLARATION alone — re-addressing a live rule is the sovereign act, not a fork", async () => {
    const c = resolvingCore();
    const first = await ruleAt(c, TEXT, "docker build", "Bash:docker build .");
    const moved = await c.declare({ species: "rule", stage: "npm install", scope: "domain", content: TEXT });
    if (moved.species !== "rule") throw new Error("unreachable");
    expect(moved.conceptId).toBe(first.conceptId);
    expect(c.ruleBinding(first.conceptId)!.stage_id).toBe(c.stages().find((s) => s.name === "npm install")!.id);
    expect(c.resolutionStats("default").byMode.some((m) => m.mode === "stage-fork")).toBe(false);
    c.close();
  });

  it("forks onto a stage that does not exist yet — a to-be-created stage differs from every incumbent", async () => {
    const c = resolvingCore();
    const first = await ruleAt(c, TEXT, "docker build", "Bash:docker build .");
    expect(c.stages().map((s) => s.name)).toEqual(["docker build"]);
    const second = await ruleAt(c, TEXT, "terraform apply", "Bash:terraform apply");
    expect(second.resolutionMode).toBe("stage-fork");
    expect(second.conceptId).not.toBe(first.conceptId);
    // The stage is born with the forked rule, exactly as any other rule birth births its stage.
    expect(c.stages().map((s) => s.name).sort()).toEqual(["docker build", "terraform apply"]);
    expect(c.gate({ actionContext: "Bash:terraform apply" }).rules.map((r) => r.conceptId)).toEqual([second.conceptId]);
    c.close();
  });
});

describe("5-B: fire-time doubt disclosure", () => {
  it("a projected rule whose parent is under impeachment says so — on the gate and on the wire", async () => {
    const c = core();
    const declared = await c.declare({ species: "principle", content: "Irreversible acts get a confirmation." });
    if (declared.species !== "principle") throw new Error("unreachable");
    const principle = declared.conceptId;
    const projected = await c.store("Confirm the target namespace before deleting a release.", {
      kind: "rule",
      rule: { stage: "helm delete", instance: "Bash:helm delete my-release", scope: "domain", projectedFromPrincipleId: principle },
    });
    // BEFORE: a parent in good standing announces provenance and nothing else.
    expect(c.gate({ actionContext: "Bash:helm delete my-release", record: false }).rules[0]!.parentDisputed).toBeUndefined();
    expect(c.stageLookup({ stage: "helm delete" }).rules[0]!.parentDisputed).toBeUndefined();

    // A SECOND rule under the same principle is corrected — that is what impeaches the parent, and
    // it is a different rule from the one firing below, which is the whole point: the rule that
    // fires is untouched and still governs.
    const sibling = await c.store("Snapshot the volume before deleting a stateful set.", {
      kind: "rule", rule: { stage: "kubectl delete", instance: "Bash:kubectl delete sts x", scope: "domain", projectedFromPrincipleId: principle },
    });
    await c.store("Snapshot the volume AND drain the node before deleting a stateful set.", {
      kind: "correction", attachTo: sibling.conceptId,
    });
    expect((await c.getConcept(principle))!.status).toBe("disputed");

    // AFTER: same rule, same severity, still delivered — plus the disclosure.
    const fired = c.gate({ actionContext: "Bash:helm delete my-release", record: false });
    expect(fired.rules).toHaveLength(1);
    expect(fired.rules[0]).toMatchObject({
      conceptId: projected.conceptId,
      severity: "advisory",
      projectedFromPrincipleId: principle,
      parentDisputed: true,
    });
    // The recognized surface carries it identically — the MCP wire shaping is pinned separately,
    // in the MCP surface block below.
    expect(c.stageLookup({ stage: "helm delete" }).rules[0]).toMatchObject({
      conceptId: projected.conceptId, parentDisputed: true,
    });
    c.close();
  });

  it("keeps the earliest display parent but discloses when a later derivation parent is disputed", async () => {
    const c = core();
    const earliest = await c.declare({ species: "principle", content: "Irreversible acts get a confirmation." });
    const later = await c.declare({ species: "principle", content: "Risk belongs with the actor who can reverse it." });
    if (earliest.species !== "principle" || later.species !== "principle") throw new Error("unreachable");
    const shared = await c.store("Confirm the target namespace before deleting a release.", {
      kind: "rule", rule: { stage: "helm delete", instance: "Bash:helm delete my-release", scope: "domain" },
    });
    c.addLifecycleEdge({ family: "derivation", srcConceptId: earliest.conceptId, dstConceptId: shared.conceptId, bornOf: "extraction" });
    c.addLifecycleEdge({ family: "derivation", srcConceptId: later.conceptId, dstConceptId: shared.conceptId, bornOf: "extraction" });
    const laterSibling = await c.store("Snapshot the volume before deleting a stateful set.", {
      kind: "rule", rule: { stage: "kubectl delete", instance: "Bash:kubectl delete sts x", scope: "domain" },
    });
    c.addLifecycleEdge({ family: "derivation", srcConceptId: later.conceptId, dstConceptId: laterSibling.conceptId, bornOf: "extraction" });

    await c.store("Snapshot the volume AND drain the node before deleting a stateful set.", {
      kind: "correction", attachTo: laterSibling.conceptId,
    });
    expect((await c.getConcept(earliest.conceptId))!.status).toBe("active");
    expect((await c.getConcept(later.conceptId))!.status).toBe("disputed");
    const firing = c.gate({ actionContext: "Bash:helm delete my-release", record: false }).rules[0]!;
    expect(firing.projectedFromPrincipleId).toBe(earliest.conceptId);
    expect(firing.parentDisputed).toBe(true);
    // THE PATH SPLIT (PR #112 round 8): the mechanical gate carries the flag alone — the hook
    // renders title + reason and never these ids, so the hot path pays no identity aggregation.
    expect(firing.disputedParentIds).toBeUndefined();
    // The recovery path the flag advertises (PR #112 round 2): WHICH parent, not just "one of
    // them" — delivered where the recovery lives, on the budget-fitted lookup path.
    const looked = c.stageLookup({ stage: "helm delete" }).rules[0]!;
    expect(looked.parentDisputed).toBe(true);
    expect(looked.disputedParentIds).toEqual([later.conceptId]);

    const impeachmentId = (raw(c).prepare(
      `SELECT id FROM contradictions WHERE concept_id = ? AND kind = 'impeachment' AND status = 'open'`,
    ).get(later.conceptId) as { id: string }).id;
    c.resolveContradiction(impeachmentId, { decision: "dismiss", by: "john" });
    const mediated = c.gate({ actionContext: "Bash:helm delete my-release", record: false }).rules[0]!;
    expect(mediated.projectedFromPrincipleId).toBe(earliest.conceptId);
    expect(mediated.parentDisputed).toBeUndefined();
    expect(mediated.disputedParentIds).toBeUndefined();
    c.close();
  });

  /**
   * A SETTLED PARENT IS NOT A PENDING MEDIATION (review fix — PR #112 round 5), two halves:
   * `reject` now closes open impeachments exactly as `retire` does (it ends membership by
   * latest-wins and is reachable on a disputed candidate), and the disclosure's read side is
   * membership-restricted like the impeachment write side — so a parent disputed over a plain
   * value-conflict whose latest verdict is `reject` stops appearing in `disputedParentIds` even
   * though its concept status is still disputed.
   */
  it("drops a REJECTED parent from the disclosure — reject closes impeachments and ends membership", async () => {
    const c = core();
    const parent = await c.declare({ species: "principle", content: "Irreversible acts get a confirmation." });
    if (parent.species !== "principle") throw new Error("unreachable");
    const child = await c.store("Confirm the target namespace before deleting a release.", {
      kind: "rule", rule: { stage: "helm delete", instance: "Bash:helm delete my-release", scope: "domain", projectedFromPrincipleId: parent.conceptId },
    });
    // Half 1: an impeachment answered by REJECT closes, and the projection recomputes to active.
    const sibling = await c.store("Snapshot the volume before deleting a stateful set.", {
      kind: "rule", rule: { stage: "kubectl delete", instance: "Bash:kubectl delete sts x", scope: "domain", projectedFromPrincipleId: parent.conceptId },
    });
    await c.store("Snapshot AND drain before deleting a stateful set.", { kind: "correction", attachTo: sibling.conceptId });
    expect((await c.getConcept(parent.conceptId))!.status).toBe("disputed");
    const rejected = await c.ratify({ candidateId: parent.conceptId, verdict: "reject", ratifiedBy: "john" });
    expect(rejected.impeachmentsClosed).toBe(1);
    expect((await c.getConcept(parent.conceptId))!.status).toBe("active");
    const afterReject = c.gate({ actionContext: "Bash:helm delete my-release", record: false }).rules[0]!;
    expect(afterReject.conceptId).toBe(child.conceptId);
    expect(afterReject.parentDisputed).toBeUndefined();

    // Half 2: a parent still DISPUTED (ordinary value-conflict) whose latest verdict is reject is
    // a settled membership question — the read side must not direct anyone to mediate it as doubt.
    c.flagContradiction(parent.conceptId, { detail: "content dispute, not an impeachment" });
    expect((await c.getConcept(parent.conceptId))!.status).toBe("disputed");
    const stillSettled = c.gate({ actionContext: "Bash:helm delete my-release", record: false }).rules[0]!;
    expect(stillSettled.parentDisputed).toBeUndefined();
    expect(stillSettled.disputedParentIds).toBeUndefined();
    c.close();
  });

  /**
   * BOUNDED ON THE HOT PATH (review fix — PR #112 round 5): the disputed-parents scalar rides the
   * mechanical gate, derivation rows are append-only with no per-rule cap, so the aggregation
   * fetches at most DISPUTED_PARENTS_CAP + 1 ids and the mapper delivers the cap plus a
   * truncation signal.
   */
  it("caps disputedParentIds and signals truncation past the cap", async () => {
    const c = core();
    const child = await c.store("Confirm the target namespace before deleting a release.", {
      kind: "rule", rule: { stage: "helm delete", instance: "Bash:helm delete my-release", scope: "domain" },
    });
    const parents: string[] = [];
    for (let i = 0; i < 9; i++) {
      const p = await c.declare({ species: "principle", content: `Distinct governing principle number ${i} about irreversible acts.` });
      if (p.species !== "principle") throw new Error("unreachable");
      c.addLifecycleEdge({ family: "derivation", srcConceptId: p.conceptId, dstConceptId: child.conceptId, bornOf: "extraction" });
      c.flagContradiction(p.conceptId, { kind: "impeachment", detail: `impeachment evidence for parent ${i}` });
      parents.push(p.conceptId);
    }
    // The mechanical gate carries the flag alone (PR #112 round 8's path split)…
    const firing = c.gate({ actionContext: "Bash:helm delete my-release", record: false }).rules[0]!;
    expect(firing.parentDisputed).toBe(true);
    expect(firing.disputedParentIds).toBeUndefined();
    // …and the lookup path pays for — and caps — the identity aggregation.
    const looked = c.stageLookup({ stage: "helm delete" }).rules[0]!;
    expect(looked.parentDisputed).toBe(true);
    expect(looked.disputedParentIds).toHaveLength(8);
    expect(looked.disputedParentsTruncated).toBe(true);
    // DETERMINISTIC PREFIX (PR #112 round 7, P3): the capped subset is the lexically-smallest ids,
    // not an insert-order accident — two replicas holding the same edges disclose the same parents.
    expect(looked.disputedParentIds).toEqual([...parents].sort().slice(0, 8));
    c.close();
  });

  it("omits the flag entirely when the parent is fine, and when there is no parent at all", async () => {
    const c = core();
    const plain = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", scope: "domain" },
    });
    const rule = c.gate({ actionContext: "Bash:git push --force", record: false }).rules[0]!;
    expect(rule.conceptId).toBe(plain.conceptId);
    expect(rule.projectedFromPrincipleId).toBeUndefined();
    expect(rule.parentDisputed).toBeUndefined();
    expect(Object.keys(rule)).not.toContain("parentDisputed"); // omitted, never `false`
    c.close();
  });

  it("clears once the human mediates — the flag is live state, not a stamp", async () => {
    const c = core();
    const declared = await c.declare({ species: "principle", content: "Irreversible acts get a confirmation." });
    if (declared.species !== "principle") throw new Error("unreachable");
    const projected = await c.store("Confirm the target namespace before deleting a release.", {
      kind: "rule",
      rule: { stage: "helm delete", instance: "Bash:helm delete my-release", scope: "domain", projectedFromPrincipleId: declared.conceptId },
    });
    const sibling = await c.store("Snapshot the volume before deleting a stateful set.", {
      kind: "rule", rule: { stage: "kubectl delete", instance: "Bash:kubectl delete sts x", scope: "domain", projectedFromPrincipleId: declared.conceptId },
    });
    await c.store("Snapshot the volume AND drain the node first.", { kind: "correction", attachTo: sibling.conceptId });
    expect(c.gate({ actionContext: "Bash:helm delete my-release", record: false }).rules[0]!.parentDisputed).toBe(true);

    const contradictionId = (raw(c).prepare(
      `SELECT id FROM contradictions WHERE concept_id = ? AND kind = 'impeachment'`,
    ).get(declared.conceptId) as { id: string }).id;
    c.resolveContradiction(contradictionId, { decision: "dismiss", by: "john" });

    const after = c.gate({ actionContext: "Bash:helm delete my-release", record: false }).rules[0]!;
    expect(after.conceptId).toBe(projected.conceptId);
    expect(after.projectedFromPrincipleId).toBe(declared.conceptId);
    expect(after.parentDisputed).toBeUndefined();
    c.close();
  });
});

// ---------------------------------------------------------------------------
// the gate mirror
// ---------------------------------------------------------------------------
describe("gate mirror — the materialized mirror", () => {
  const read = (path: string): GateMirror => JSON.parse(readFileSync(path, "utf8")) as GateMirror;

  /** stageName moved off the entry and onto the mirror's own stage registry in format 4 — cross-
   *  reference by stageId, the same join `evaluateGateFromMirror` does at read time. */
  const stageNamesOf = (mirror: GateMirror): string[] =>
    mirror.entries.map((e) => mirror.stages.find((s) => s.id === e.stageId)!.name);

  it("regenerates on every declaration, atomically, leaving no temp file behind", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, syncDeviceId: "machine-a" });

    // An advisory declaration still rebuilds the mirror — and, as of format 4, writes an entry for
    // it: entries carries every live rule, not only blocking ones, so an all-advisory store is no
    // longer indistinguishable from an empty one. It ALSO rebuilds the stage registry: the new stage
    // appears in `stages` regardless of severity, since a rule-less-here stage can still MATCH —
    // see GateMirror.stages' own comment.
    await c.declare({ species: "rule", stage: "terraform apply", content: "Always run plan first.", ...AGENT_RULE });
    expect(read(path)).toMatchObject({
      storeIdentity: "machine-a",
      entries: [expect.objectContaining({ severity: "advisory", text: "Always run plan first" })],
    });
    expect(read(path).stages).toEqual([expect.objectContaining({ name: "terraform apply" })]);

    const declared = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a directory tree unattended.",
      severity: "blocking", reason: "there is no undo", declaredBy: "john", ...AGENT_RULE,
    });
    if (declared.species !== "rule") throw new Error("unreachable");

    const sidecar = read(path);
    // TWO now: the earlier advisory "terraform apply" rule is still here (format 4 never drops an
    // advisory rule the way the blocking-only mirror implicitly did), plus this new blocking one.
    // Blocking sorts first regardless of creation order (gate-delivery order — see
    // listGateMirrorEntries), so entries[0] is still the one this test is pinning field-for-field.
    expect(sidecar.entries).toHaveLength(2);
    expect(sidecar.entries[0]).toMatchObject({
      conceptId: declared.conceptId,
      stageId: declared.binding.stage_id,
      severity: "blocking",
      text: "Never delete a directory tree unattended",
      reason: "there is no undo",
      circle: "default",
      scope: "agent",
      modelTag: "test-model-1",
      origin: "declaration",
    });
    // declaredBy is NOT projected into the mirror — GateRule (the live delivery shape this mirror
    // promises to match) never carries it either; it stays queryable via c.ruleBinding() instead.
    expect(sidecar.entries[0]).not.toHaveProperty("declaredBy");
    const rmStage = sidecar.stages.find((s) => s.id === declared.binding.stage_id)!;
    expect(rmStage.name).toBe("rm -rf");
    expect(parseTriggerPatterns(rmStage.triggerPatterns)).toEqual([{ tool: "bash", tokens: ["rm", "-rf"] }]);
    expect(typeof sidecar.generatedAt).toBe("number");

    // Atomic: tmp+rename, so the directory holds exactly the finished file.
    expect(readdirSync(dir)).toEqual(["gate-sidecar.json"]);

    // A second deny joins it, in the gate's own deterministic order — blocking-first, then
    // created_at ASC: "rm -rf" was declared first, so it sorts before "git force push" even though
    // the latter's NAME sorts first alphabetically.
    await c.declare({
      species: "rule", stage: "git force push", patterns: ["Bash:git push --force"],
      content: "Never force-push to main.", severity: "blocking",
      reason: "a rewritten history cannot be recovered from a teammate's clone", ...AGENT_RULE,
    });
    // Three now: the two blocking rules (created-order, since severity ties within them) precede
    // the standing advisory "terraform apply" one from the top of this test — severity dominates the
    // sort, so it sorts last regardless of when it was declared.
    expect(stageNamesOf(read(path))).toEqual(["rm -rf", "git force push", "terraform apply"]);

    // The mirror follows the store — but a live deny cannot simply be retired any more (the
    // chokepoint refuses), so withdrawing it is a declaration first and ordinary cleanup after.
    expect(() => c.retireConcept(declared.conceptId)).toThrow(/would remove the blocking rule/);
    await withdrawDeny(c, declared.conceptId, "rm -rf");
    c.retireConcept(declared.conceptId);
    // "rm -rf" is gone (retired); "git force push" (still blocking) sorts before "terraform apply"
    // (advisory, untouched throughout).
    expect(stageNamesOf(c.materializeGateMirror().sidecar)).toEqual(["git force push", "terraform apply"]);
    expect(stageNamesOf(read(path))).toEqual(["git force push", "terraform apply"]);
    c.close();
  });

  it("downgrades a deny to advisory in the mirror rather than dropping the rule — the DENY leaves, the RULE stays", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    // Dedup ON, so a re-declaration of the same rule text lands on the same concept — which is what
    // makes it an EDIT of the existing rule rather than a second one.
    const c = new MonetCore(":memory:", { gateSidecarPath: path, syncDeviceId: "machine-a" });
    const first = await c.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a directory tree unattended.",
      severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (first.species !== "rule") throw new Error("unreachable");
    expect(read(path).entries).toHaveLength(1);
    expect(read(path).entries[0]).toMatchObject({ conceptId: first.conceptId, severity: "blocking" });

    const again = await c.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a directory tree unattended.",
      severity: "advisory", ...AGENT_RULE,
    });
    if (again.species !== "rule") throw new Error("unreachable");
    expect(again.conceptId).toBe(first.conceptId);
    // NOT empty as of format 4: the mirror carries every live rule, both severities, so the rule
    // stays visible — only its DENY POWER left. A v3 reader would have seen entries go empty here;
    // a v4 reader sees the same one entry, now advisory.
    expect(read(path).entries).toHaveLength(1);
    expect(read(path).entries[0]).toMatchObject({ conceptId: first.conceptId, severity: "advisory" });
    c.close();
  });

  it("carries scope and model tag so the offline hook can filter exactly as the live gate does", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    const compensation = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Old model deletes without confirming.", severity: "blocking", scope: "agent", modelTag: "model-1",
      reason: "this model deletes without asking first",
    });
    await c.declare({
      species: "rule", stage: "rm -rf",
      content: "Deleting a tree is irreversible.", severity: "blocking", scope: "domain",
      reason: "a deleted tree is not in any trash",
    });
    if (compensation.species !== "rule") throw new Error("unreachable");

    const sidecar = read(path);
    // 4 since the mirror stopped being blocking-only: `entries` now carries every live rule, both
    // severities, and gained stage/circle-map siblings. A v3 reader pointed at this file would read
    // `entries` as blocking-only and MISS every advisory rule silently — the shape change earns the
    // bump for the same reason the v2→v3 one did.
    expect(sidecar.format).toBe(4);
    // Without these fields the hook cannot apply the runtime-model filter gateQuery applies, so a
    // compensation for a retired model keeps denying whenever the server is unreachable — live and
    // offline disagreeing exactly when it is hardest to notice.
    expect(sidecar.entries.map((e) => [e.scope, e.modelTag]).sort()).toEqual([["agent", "model-1"], ["domain", null]]);

    // The live gate's answer under model-2 is the one the hook must be able to reproduce.
    const live = c.gate({ actionContext: "Bash:rm -rf /tmp/x", runtimeModelTag: "model-2" });
    expect(live.rules).toHaveLength(1);
    expect(live.rules[0]!.scope).toBe("domain");
    const offline = sidecar.entries.filter((e) => e.scope === "domain" || e.modelTag === "model-2");
    expect(offline.map((e) => e.conceptId)).toEqual(live.rules.map((r) => r.conceptId));
    c.close();
  });

  it("writes nothing when no path was configured, and rebuilds on demand from an explicit one", async () => {
    const dir = mkTmp();
    const path = join(dir, "sidecar.json");
    const c = core();
    await c.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a tree unattended.", severity: "blocking",
      reason: "there is no undo", ...AGENT_RULE,
    });
    // No gateSidecarPath: a MonetCore must never write into somebody's real store directory just
    // because it was constructed.
    expect(existsSync(path)).toBe(false);
    expect(() => c.materializeGateMirror()).toThrow(/needs a path/);

    const rebuilt = c.materializeGateMirror(path);
    // Explicit recovery against a path that held no file: this is the caller install tooling is,
    // and "written" is the answer that entitles it to say the mirror was regenerated.
    expect(rebuilt.outcome).toBe("written");
    expect(rebuilt.sidecar.entries).toHaveLength(1);
    expect(read(path).entries[0]!.text).toBe("Never delete a tree unattended");
    c.close();
  });
});

// ---------------------------------------------------------------------------
// evaluateGateFromMirror — parity with live gateQuery
// ---------------------------------------------------------------------------
/**
 * THE SLICE'S CORRECTNESS BAR. `evaluateGateFromMirror` exists to answer the SAME question
 * `MonetCore.gate()` does, from a materialized `GateMirror` alone — this is the property-style test
 * 4b-C's CLI stands on: for every action context in a representative battery, against a
 * representative rule/stage population, the offline verdict must equal the live one, field-for-field.
 *
 * COMPARED AGAINST `c.gate()`, NOT raw `gateQuery` (review fix — MATERIAL M3; this battery compared
 * `gateQuery` directly until this fix). `gateQuery`/`evaluateGate` are PRE-resolution — they take a
 * circle literally and never touch `circle_aliases` — because circle-alias resolution is
 * `MonetCore.gate()`'s own job (`resolveCircle`, called before `evaluateGate`), not gateInternal's.
 * `evaluateGateFromMirror` now resolves aliases itself (this same fix — see its own comment), which
 * means it does MORE than raw `gateQuery` does: comparing it against `gateQuery` directly would
 * FALSELY DISAGREE for a renamed circle's old name (offline resolves and delivers; raw gateQuery
 * does not, on purpose) while HIDING the actual bug this fix closes — that comparing it against raw
 * `gateQuery` in the first place could never catch a renamed circle going invisible offline, because
 * neither side resolved. `c.gate()` is the surface a real caller actually uses, live; it is the one
 * `evaluateGateFromMirror` must match.
 *
 * REPRESENTATION DIFFERENCES, enumerated rather than silently allowed to pass by coincidence:
 *
 *   `source` — "live" vs "sidecar". The ONE field the two are SUPPOSED to disagree on; asserted
 *   explicitly below rather than compared for equality.
 *
 *   `GateRule.projectedFromPrincipleId` — WAS a gap, CLOSED in slice 5-B (D4). `GateMirrorEntry`
 *   now carries the parent principle, populated by the same correlated pick the live path uses, so
 *   the battery below no longer merely permits the two to agree by coincidence: fixture (12) is a
 *   genuinely projected rule with a live parent, and the field-for-field comparison covers it. If
 *   the mirror ever stops carrying it, this test fails rather than going quiet.
 *
 *   `GateRule.parentDisputed` — the ONE remaining difference, and deliberately permanent (slice
 *   5-B, D5). It reads the parent principle's LIVE status, which is not an act and therefore not
 *   something a build artifact may freeze: a mirrored copy would keep announcing doubt after a
 *   human resolved it. The battery's parent principle is deliberately kept UNDISPUTED so both sides
 *   agree here; the divergence itself is pinned by its own test just below, so "they agree" is a
 *   fixture property this file states out loud rather than an accident nobody checked.
 */
describe("evaluateGateFromMirror — parity with live gate()", () => {
  const dbOf = (c: MonetCore): StoragePort => (c as unknown as { db: StoragePort }).db;

  it("answers THE SAME verdict as live gateQuery, field-for-field, across a representative population", async () => {
    const c = core({ circle: "default" });
    const db = dbOf(c);

    // ---- the population ---------------------------------------------------
    // (1) "git force push" — narrow, BLOCKING, agent-scoped, tag "model-a".
    const forcePush = await c.declare({
      species: "rule", stage: "git force push", patterns: ["Bash:git push --force"],
      content: "Never force-push to a shared branch.", severity: "blocking",
      reason: "a rewritten history cannot be recovered from a teammate's clone",
      scope: "agent", modelTag: "model-a",
    });
    if (forcePush.species !== "rule") throw new Error("unreachable");

    // (2) "git push" — BROAD, overlaps with (1)'s contexts, advisory, domain (always fires). Tests
    //     the multi-stage union: a broad advisory stage and a narrow blocking stage both firing on
    //     one action, blocking ranked first regardless of which stage is "broader".
    await c.declare({
      species: "rule", stage: "git push", patterns: ["Bash:git push"],
      content: "Prefer a merge over a rebase on a shared branch.", severity: "advisory", scope: "domain",
    });

    // (3) "rm -rf" — ONE stage, TWO rules: domain blocking (always fires) + agent advisory (tag
    //     "model-a"). Tests severity union WITHIN one stage and the domain-always-fires rule.
    await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Deleting a tree is irreversible.", severity: "blocking",
      reason: "a deleted tree is not in any trash", scope: "domain",
    });
    await c.declare({
      species: "rule", stage: "rm -rf",
      content: "Confirm the target path before deleting.", severity: "advisory",
      scope: "agent", modelTag: "model-a",
    });

    // (4) "npm publish" — agent-only, tag "model-b", FOREIGN relative to "model-a". Tests
    //     tag-filtered stage-hit-no-rules (the stage matches; the only rule bound to it does not
    //     deliver for a foreign runtime tag).
    await c.declare({
      species: "rule", stage: "npm publish", patterns: ["Bash:npm publish"],
      content: "Run the dry-run publish first.", severity: "advisory", scope: "agent", modelTag: "model-b",
    });

    // (5) "terraform apply" — a TOOL-LESS pattern (fires under any tool prefix), advisory, domain,
    //     NO reason (advisory + no reason is ordinary, never reasonMissing).
    await c.declare({
      species: "rule", stage: "terraform apply", patterns: ["terraform apply"],
      content: "Always run plan before apply.", severity: "advisory", scope: "domain",
    });

    // (6) "kubectl delete" — a stage with ZERO rules bound. Tests stage-hit-no-rules the OTHER way:
    //     no tag filtering involved, the stage simply has nothing bound to it anywhere.
    await c.declare({ species: "stage", stage: "kubectl delete", patterns: ["kubectl delete"] });

    // (7) "docker prune" — one SUPERSEDED rule, one live successor on the SAME stage/pattern.
    const dockerOriginal = await c.store("Never prune without checking what is running.", {
      kind: "rule", rule: { stage: "docker prune", instance: "Bash:docker system prune -a", scope: "domain" },
    });
    const dockerSuccessor = await c.store("Confirm containers are stopped before pruning.", {
      kind: "correction", attachTo: dockerOriginal.conceptId,
    });

    // (8) "eslint --fix" — TWO advisory rules on one stage, one RETIRED. Tests that retirement
    //     excludes exactly the retired rule, not its still-live stage-mate.
    const eslintKeep = await c.store("Run eslint --fix only on staged files.", {
      kind: "rule", rule: { stage: "eslint --fix", instance: "Bash:eslint --fix .", scope: "domain" },
    });
    const eslintRetired = await c.store("Review the diff after autofixing.", {
      kind: "rule", rule: { stage: "eslint --fix", scope: "domain" },
    });
    c.retireConcept(eslintRetired.conceptId);

    // (9) cross-circle — a blocking rule living in a DIFFERENT circle, on its own stage. Tests that
    //     GateMirrorEntry.circle is respected exactly like RULE_LIVENESS_WHERE's c.circle = ?.
    await c.declare({
      circle: "other-circle", species: "rule", stage: "azure delete", patterns: ["Bash:az group delete"],
      content: "Never delete a resource group without a snapshot.", severity: "blocking",
      reason: "a deleted resource group has no undo", scope: "domain",
    });

    // (10) BREADTH — a global blocking rule (circle: "*") sharing a stage with a LOCAL advisory
    //      rule in "default". Tests the union itself (both arrive, blocking-first, in the circle
    //      that also has the local rule) AND that breadth alone reaches a circle with NOTHING local
    //      bound to this stage at all — the whole point of "*", not merely a side effect of it.
    const breadthDeny = await c.declare({
      circle: BREADTH_CIRCLE, species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Never install without a lockfile present.", severity: "blocking",
      reason: "an unlocked install can pull an unreviewed transitive dependency", scope: "domain",
    });
    if (breadthDeny.species !== "rule") throw new Error("unreachable");
    // THE CONCEPT/BINDING SPLIT ITSELF, checked directly: the CONCEPT lives at the caller's own
    // circle ("default", searchable/listable there like any other) while only the BINDING carries
    // the breadth marker — the whole premise `RuleBindingRow.circle`'s own comment states.
    expect((raw(c).prepare(`SELECT circle FROM concepts WHERE id = ?`).get(breadthDeny.conceptId) as { circle: string }).circle)
      .toBe("default");
    expect(c.ruleBinding(breadthDeny.conceptId)).toMatchObject({ circle: BREADTH_CIRCLE });
    await c.declare({
      circle: "default", species: "rule", stage: "npm install",
      content: "Prefer `npm ci` over `npm install` in automation.", severity: "advisory", scope: "domain",
    });

    // (11) ALIAS — a rule declared in "proj", then the circle renamed to "project" (review fix —
    //      MATERIAL M3). After the rename, `mirror.entries[].circle` reads "project" — the CANONICAL
    //      name — same as the live concept row does; only `mirror.circleAliases` still remembers
    //      "proj". A caller querying "proj" reaches the live rule ONLY because MonetCore.gate()
    //      resolves through circle_aliases before ever calling evaluateGate; evaluateGateFromMirror
    //      must resolve identically or a renamed circle's rules go permanently invisible offline
    //      under the name every existing caller still has cached. This is the exact fixture that
    //      would have caught the gap M3 closed — see evaluateGateFromMirror's own comment.
    const aliasRule = await c.declare({
      circle: "proj", species: "rule", stage: "helm delete", patterns: ["Bash:helm delete"],
      content: "Never delete a release without checking its dependents.", severity: "blocking",
      reason: "a dangling dependent release fails silently on its next upgrade", scope: "domain",
    });
    if (aliasRule.species !== "rule") throw new Error("unreachable");
    c.renameCircle("proj", "project");

    // (12) PROJECTION (slice 5-B, D4) — a ratified principle and a rule projected from it, so the
    //      battery actually exercises `projectedFromPrincipleId` on both sides instead of passing
    //      because every rule in it happens to be parentless. The parent stays UNDISPUTED on
    //      purpose: `parentDisputed` is live-only by design (see this block's own comment).
    const parentPrinciple = await c.declare({
      species: "principle", content: "A build artifact is a snapshot — re-materialize after the source changes.",
    });
    if (parentPrinciple.species !== "principle") throw new Error("unreachable");
    const projectedRule = await c.store("Rebuild the image before deploying after a lockfile change.", {
      kind: "rule",
      rule: { stage: "docker build", instance: "Bash:docker build .", scope: "domain", projectedFromPrincipleId: parentPrinciple.conceptId },
    });

    const materialized = c.materializeGateMirror(join(mkTmp(), "gate-mirror.json"));
    expect(materialized.outcome).toBe("written");
    const mirror = materialized.sidecar;
    expect(mirror.format).toBe(GATE_MIRROR_FORMAT);

    // ---- the battery: hits, misses, stage-hit-no-rules, overflow, tag-filtered, quoting/case -----
    const scenarios: Array<{ label: string; actionContext: string; circle?: string; runtimeModelTag?: string }> = [
      // multi-stage union (narrow blocking + broad advisory), across the tag axis
      { label: "narrow+broad both match, tag matches the narrow rule", actionContext: "Bash:git push --force origin main", runtimeModelTag: "model-a" },
      { label: "narrow+broad both match, unconfigured tag", actionContext: "Bash:git push --force origin main" },
      { label: "narrow rule filtered by a foreign tag, broad advisory still fires", actionContext: "Bash:git push --force origin main", runtimeModelTag: "model-b" },
      { label: "an ordinary push matches only the broad stage", actionContext: "Bash:git push origin main", runtimeModelTag: "model-a" },

      // one stage, two rules (domain always-fires + agent tag-filtered)
      { label: "rm -rf: domain+agent union, matching tag", actionContext: "Bash:rm -rf /tmp/x", runtimeModelTag: "model-a" },
      { label: "rm -rf: domain only, foreign tag", actionContext: "Bash:rm -rf /tmp/x", runtimeModelTag: "model-b" },
      { label: "rm -rf: domain+agent union, unconfigured tag", actionContext: "Bash:rm -rf /tmp/x" },

      // tag-filtered stage-hit-no-rules
      { label: "npm publish: tag matches", actionContext: "Bash:npm publish --access public", runtimeModelTag: "model-b" },
      { label: "npm publish: foreign tag -> stage-hit-no-rules", actionContext: "Bash:npm publish --access public", runtimeModelTag: "model-a" },
      { label: "npm publish: unconfigured -> delivers", actionContext: "Bash:npm publish --access public" },

      // tool-less pattern
      { label: "terraform apply via a tool-less pattern", actionContext: "Bash:terraform apply -auto-approve" },
      { label: "terraform plan does not match", actionContext: "Bash:terraform plan" },

      // pure stage-hit-no-rules (no rule bound anywhere, no tag involved)
      { label: "kubectl delete: stage-hit-no-rules", actionContext: "Bash:kubectl delete pod x" },

      // supersession / retirement exclusion
      { label: "docker prune: only the successor delivers", actionContext: "Bash:docker system prune -a" },
      { label: "eslint --fix: only the live sibling delivers", actionContext: "Bash:eslint --fix ." },

      // miss and overflow
      { label: "a plain miss", actionContext: "Bash:ls -la" },
      { label: "overflow past the refusal threshold", actionContext: `Bash:${"x".repeat(4 * 1024 * 1024 + 16)} && git push --force` },

      // quoting/case variants the matcher normalizes — same underlying command as the first scenario
      { label: "case-folded", actionContext: "Bash:GIT PUSH --FORCE origin main", runtimeModelTag: "model-a" },
      { label: "double-quoted", actionContext: `Bash:git "push" --force origin main`, runtimeModelTag: "model-a" },
      { label: "single-quoted", actionContext: "Bash:git 'push' '--force' origin main", runtimeModelTag: "model-a" },
      { label: "backslash-escaped", actionContext: "Bash:git push \\-\\-force origin main", runtimeModelTag: "model-a" },

      // circle scoping
      { label: "cross-circle rule invisible from default (stage-hit-no-rules)", actionContext: "Bash:az group delete --yes", circle: "default" },
      { label: "cross-circle rule visible from its own circle", actionContext: "Bash:az group delete --yes", circle: "other-circle" },

      // BREADTH: the global deny unions with the local advisory in "default", and reaches
      // "other-circle" and a THIRD circle with nothing local bound to this stage at all — the
      // reach is not an accident of which circles happen to already appear elsewhere in this test.
      { label: "breadth: unions with the local advisory in the circle that has one", actionContext: "Bash:npm install", circle: "default" },
      { label: "breadth: alone, reaching a circle with a local rule on OTHER stages but not this one", actionContext: "Bash:npm install", circle: "other-circle" },
      { label: "breadth: alone, reaching a circle that has never appeared in this fixture at all", actionContext: "Bash:npm install", circle: "a-circle-nothing-else-ever-touches" },

      // ALIAS (MATERIAL M3): the renamed-away name and the canonical name both deliver, identically,
      // on both surfaces — the fixture that would have caught evaluateGateFromMirror answering
      // "proj" with nothing while c.gate() answered it with the rule.
      { label: "alias: the renamed-away name ('proj') still resolves and delivers", actionContext: "Bash:helm delete my-release", circle: "proj" },
      { label: "alias: the canonical name ('project') delivers directly", actionContext: "Bash:helm delete my-release", circle: "project" },

      // PROJECTION (5-B, D4): the parent principle must reach the offline answer too.
      { label: "projection: the parent principle rides the mirror", actionContext: "Bash:docker build ." },
    ];

    for (const scenario of scenarios) {
      const opts = { actionContext: scenario.actionContext, circle: scenario.circle ?? "default", runtimeModelTag: scenario.runtimeModelTag };
      const live = c.gate({ ...opts, record: false });
      const offline = evaluateGateFromMirror(mirror, opts);
      expect(offline.silence, scenario.label).toBe(live.silence);
      expect(offline.overflow, scenario.label).toBe(live.overflow);
      expect(offline.stage, scenario.label).toEqual(live.stage);
      expect(offline.stages, scenario.label).toEqual(live.stages);
      expect(offline.rules, scenario.label).toEqual(live.rules);
      // The one deliberate, documented difference — see this describe block's own comment.
      expect(live.source, scenario.label).toBe("live");
      expect(offline.source, scenario.label).toBe("sidecar");
    }

    // ---- independent sanity checks on the LIVE side, so the battery is not "both sides share one
    // bug" — parity alone cannot catch a mistake present in both gateInternal and the fixture's own
    // assumptions about it. ------------------------------------------------------------------------
    const union = gateQuery(db, { actionContext: "Bash:git push --force origin main", circle: "default", runtimeModelTag: "model-a", record: false });
    expect(union.rules.map((r) => r.severity)).toEqual(["blocking", "advisory"]);
    expect(union.rules.map((r) => r.conceptId)).toContain(forcePush.conceptId);

    const rmUnion = gateQuery(db, { actionContext: "Bash:rm -rf /tmp/x", circle: "default", runtimeModelTag: "model-a", record: false });
    expect(rmUnion.rules).toHaveLength(2);
    expect(rmUnion.rules[0]!.severity).toBe("blocking");

    const dockerLive = gateQuery(db, { actionContext: "Bash:docker system prune -a", circle: "default", record: false });
    expect(dockerLive.rules.map((r) => r.conceptId)).toEqual([dockerSuccessor.conceptId]);

    const eslintLive = gateQuery(db, { actionContext: "Bash:eslint --fix .", circle: "default", record: false });
    expect(eslintLive.rules.map((r) => r.conceptId)).toEqual([eslintKeep.conceptId]);

    const kubectlLive = gateQuery(db, { actionContext: "Bash:kubectl delete pod x", circle: "default", record: false });
    expect(kubectlLive).toMatchObject({ silence: false, rules: [] });

    const terraformLive = gateQuery(db, { actionContext: "Bash:terraform apply -auto-approve", circle: "default", record: false });
    expect(terraformLive.rules[0]).toMatchObject({ severity: "advisory", reason: null, reasonMissing: false });

    // BREADTH sanity: same global deny, three circles. Union + blocking-first where a local rule
    // also matches; alone (but still delivered) everywhere else — including a circle this fixture
    // never otherwise touches, proving the reach is the marker's, not an accident of overlap with
    // some OTHER fixture data that happens to also live in "other-circle".
    const npmDefault = gateQuery(db, { actionContext: "Bash:npm install", circle: "default", record: false });
    expect(npmDefault.rules.map((r) => [r.severity, r.conceptId])).toEqual([
      ["blocking", breadthDeny.conceptId],
      ["advisory", expect.any(String)],
    ]);
    const npmOther = gateQuery(db, { actionContext: "Bash:npm install", circle: "other-circle", record: false });
    expect(npmOther.rules.map((r) => r.conceptId)).toEqual([breadthDeny.conceptId]);
    const npmElsewhere = gateQuery(db, { actionContext: "Bash:npm install", circle: "a-circle-nothing-else-ever-touches", record: false });
    expect(npmElsewhere.rules.map((r) => r.conceptId)).toEqual([breadthDeny.conceptId]);
    expect(npmElsewhere.silence).toBe(false);

    // ALIAS sanity (MATERIAL M3), the representation difference made concrete: raw gateQuery is
    // PRE-resolution and takes "proj" literally — it MUST come back empty, because nothing lives at
    // that name any more, the rename moved the concept to "project". c.gate() resolves first and
    // delivers. Both are correct; they are answering different questions, and evaluateGateFromMirror
    // must agree with the SECOND one, not the first — which is exactly what the battery above pins.
    expect(c.resolveCircleName("proj")).toBe("project");
    const rawUnresolved = gateQuery(db, { actionContext: "Bash:helm delete my-release", circle: "proj", record: false });
    expect(rawUnresolved.rules).toEqual([]);
    const liveResolved = c.gate({ actionContext: "Bash:helm delete my-release", circle: "proj", record: false });
    expect(liveResolved.rules.map((r) => r.conceptId)).toEqual([aliasRule.conceptId]);

    // PROJECTION sanity (5-B, D4), so the battery's own agreement above is not "both sides carry
    // nothing": the field is genuinely PRESENT on both, and it names the right principle.
    const projectedLive = c.gate({ actionContext: "Bash:docker build .", circle: "default", record: false });
    expect(projectedLive.rules.map((r) => r.conceptId)).toEqual([projectedRule.conceptId]);
    expect(projectedLive.rules[0]!.projectedFromPrincipleId).toBe(parentPrinciple.conceptId);
    const projectedOffline = evaluateGateFromMirror(mirror, { actionContext: "Bash:docker build .", circle: "default" });
    expect(projectedOffline.rules[0]!.projectedFromPrincipleId).toBe(parentPrinciple.conceptId);
    expect(mirror.entries.find((e) => e.conceptId === projectedRule.conceptId)!.projectedFromPrincipleId)
      .toBe(parentPrinciple.conceptId);

    c.close();
  });

  /**
   * THE ONE PERMANENT DIVERGENCE, pinned rather than left to a comment (slice 5-B, D5). A frozen
   * `parentDisputed` would go stale the moment a human mediates, which is worse than absent: the
   * offline reader would announce doubt about a principle that is fine again, with no way to know.
   * Omitting is the honest failure, so this test asserts the ASYMMETRY on purpose — live says
   * `parentDisputed`, the mirror does not, and neither one's verdict, severity or rule set differs.
   */
  it("never freezes the parent's DISPUTED status into the mirror — live discloses it, offline stays silent", async () => {
    const c = core({ circle: "default" });
    const principle = await c.declare({ species: "principle", content: "Irreversible acts get a confirmation." });
    if (principle.species !== "principle") throw new Error("unreachable");
    const projected = await c.store("Confirm the target namespace before deleting a release.", {
      kind: "rule",
      rule: { stage: "helm delete", instance: "Bash:helm delete my-release", scope: "domain", projectedFromPrincipleId: principle.conceptId },
    });
    // Impeach the parent through a SIBLING rule, leaving the rule under test untouched and live.
    const sibling = await c.store("Snapshot the volume before deleting a stateful set.", {
      kind: "rule", rule: { stage: "kubectl delete", instance: "Bash:kubectl delete sts x", scope: "domain", projectedFromPrincipleId: principle.conceptId },
    });
    await c.store("Snapshot the volume AND drain the node first.", { kind: "correction", attachTo: sibling.conceptId });
    expect((await c.getConcept(principle.conceptId))!.status).toBe("disputed");

    const mirror = c.materializeGateMirror(join(mkTmp(), "gate-mirror.json")).sidecar;
    const opts = { actionContext: "Bash:helm delete my-release", circle: "default" };
    const live = c.gate({ ...opts, record: false });
    const offline = evaluateGateFromMirror(mirror, opts);

    // SAME VERDICT, SAME RULES, SAME SEVERITY — the divergence is disclosure only.
    expect(offline.silence).toBe(live.silence);
    expect(offline.rules.map((r) => [r.conceptId, r.severity])).toEqual(live.rules.map((r) => [r.conceptId, r.severity]));
    expect(live.rules[0]).toMatchObject({ conceptId: projected.conceptId, parentDisputed: true });
    // ...and the parent id IS carried, so this is a deliberate omission of ONE field, not the old gap.
    expect(offline.rules[0]!.projectedFromPrincipleId).toBe(principle.conceptId);
    expect(offline.rules[0]!.parentDisputed).toBeUndefined();
    expect(Object.keys(mirror.entries[0]!)).not.toContain("parentDisputed");
    c.close();
  });

  /**
   * BACKWARD COMPATIBILITY, the reason `GATE_MIRROR_FORMAT` was NOT bumped for D4's new field: a
   * format-4 file written before this slice carries no `projectedFromPrincipleId` on any entry, and
   * must still parse and evaluate identically — the field decides nothing, so refusing such a file
   * would have cost a working mirror to gain nothing.
   */
  it("reads a pre-5-B format-4 mirror whose entries have no parent field at all", async () => {
    const c = core({ circle: "default" });
    await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", scope: "domain" },
    });
    const path = join(mkTmp(), "gate-mirror.json");
    const current = c.materializeGateMirror(path).sidecar;
    expect(current.format).toBe(GATE_MIRROR_FORMAT);

    // An OLD file: same format number, entries stripped of the key this build knows about.
    const old: GateMirror = {
      ...current,
      entries: current.entries.map(({ projectedFromPrincipleId: _drop, ...rest }) => rest),
    };
    expect(Object.keys(old.entries[0]!)).not.toContain("projectedFromPrincipleId");

    const offline = evaluateGateFromMirror(old, { actionContext: "Bash:git push --force origin main", circle: "default" });
    expect(offline.rules).toHaveLength(1);
    expect(offline.rules[0]!.projectedFromPrincipleId).toBeUndefined();
    expect(offline).toMatchObject({ silence: false, overflow: false, source: "sidecar" });
    // And it round-trips through the real reader, not only in memory.
    writeFileSync(path, JSON.stringify(old));
    const reread = JSON.parse(readFileSync(path, "utf8")) as GateMirror;
    expect(evaluateGateFromMirror(reread, { actionContext: "Bash:git push --force origin main", circle: "default" }).rules)
      .toHaveLength(1);
    c.close();
  });
});

describe("breadth inherits into the recognized surfaces", () => {
  it("a '*' binding makes its stage live in EVERY circle's index, and stageLookup delivers the global rule unioned with local ones", async () => {
    const c = core({ circle: "default" });
    const db = (c as unknown as { db: StoragePort }).db;

    // A stage with ONLY a local advisory rule, in "default" — the control: it must NOT appear in
    // some other circle's index, proving the test below is measuring breadth, not "every stage
    // shows up everywhere regardless".
    await c.declare({
      species: "rule", stage: "eslint --fix all", patterns: ["Bash:eslint --fix --all"],
      content: "Confirm the file count before a repo-wide autofix.", severity: "advisory", scope: "domain",
    });

    // The global rule: a BLOCKING breadth binding, plus a LOCAL advisory sharing its stage in
    // "default" — same union shape the parity test's own breadth fixture uses.
    const globalDeny = await c.declare({
      circle: BREADTH_CIRCLE, species: "rule", stage: "docker system prune --all", patterns: ["Bash:docker system prune --all --volumes"],
      content: "Never prune with --volumes outside a maintenance window.", severity: "blocking",
      reason: "a volume prune destroys data no image rebuild can recover", scope: "domain",
    });
    if (globalDeny.species !== "rule") throw new Error("unreachable");
    await c.declare({
      circle: "default", species: "rule", stage: "docker system prune --all",
      content: "Announce in the ops channel before pruning.", severity: "advisory", scope: "domain",
    });

    // liveStageIndex: the global stage is live EVERYWHERE — including a circle with no local rule
    // on it at all, and no other fixture data — while the local-only stage stays put in "default".
    const elsewhere = liveStageIndex(db, "a-circle-with-nothing-of-its-own");
    expect(elsewhere.names).toContain("docker system prune --all");
    expect(elsewhere.names).not.toContain("eslint --fix all");
    const home = liveStageIndex(db, "default");
    expect(home.names).toEqual(expect.arrayContaining(["docker system prune --all", "eslint --fix all"]));

    // stageLookup (the recognized matcher): from a circle with nothing local on this stage, the
    // global deny alone still delivers — matching gateQuery's own union contract exactly, just
    // reached by name instead of by pattern.
    const recognizedElsewhere = c.stageLookup({ stage: "docker system prune --all", circle: "a-circle-with-nothing-of-its-own" });
    expect(recognizedElsewhere.matched).toBe(true);
    expect(recognizedElsewhere.rules.map((r) => r.conceptId)).toEqual([globalDeny.conceptId]);

    // And from "default", where a local advisory ALSO binds this stage: both arrive, blocking-first.
    const recognizedHome = c.stageLookup({ stage: "docker system prune --all", circle: "default" });
    expect(recognizedHome.rules.map((r) => [r.severity, r.conceptId])).toEqual([
      ["blocking", globalDeny.conceptId],
      ["advisory", expect.any(String)],
    ]);
    c.close();
  });
});

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------
/**
 * CIRCLE '*' IS NOT A QUERYABLE CIRCLE, AT ANY ENTRANCE (Codex round 6, item 2, closing batch).
 * `RULE_LIVENESS_WHERE`'s own `(b.circle = ? OR b.circle = '*')` — and evaluateGateFromMirror's
 * identical JS-side twin — degenerates to matching ONLY global rules the instant `?` itself is bound
 * to '*': both halves of the OR become the identical clause, silently dropping every LOCAL rule the
 * caller actually meant to ask about, including a local DENY. Reachable only via a direct argument
 * (a pre-breadth `MONET_CIRCLE=*` config, or any caller passing '*' straight through) — `resolveCircle`
 * can never PRODUCE '*' from an ordinary circle name post-migration (round 4, item 4: no alias can
 * ever hold '*' on either side once a store has been through it — verified, not assumed, by reading
 * resolveCircle's own single-hop lookup and confirming no write path can create such a row anymore).
 * `MonetCore.gate()`/`stageLookup()` carry no guard of their own — checked directly: both resolve
 * their circle and pass it straight into evaluateGate/evaluateStageLookup unchanged, so the SHARED
 * chokepoint one layer down (assertQueryableCircle, gates.ts) is what actually refuses for them too,
 * proven here by calling the wrappers themselves, not only the functions they funnel through.
 */
describe("circle '*' is refused as query input, everywhere a gate query can be scoped", () => {
  it("refuses at every entrance — evaluateGate, gateQuery, MonetCore.gate(), evaluateStageLookup, stageLookup (standalone), MonetCore.stageLookup(), and evaluateGateFromMirror — each naming the same repair", async () => {
    const c = core();
    await c.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Never install without a lockfile.", severity: "advisory", scope: "domain",
    });
    const db = (c as unknown as { db: StoragePort }).db;
    const message = /circle '\*' is not a queryable circle.*reserved global-breadth marker.*Name a real circle/s;

    // THE LIVE GATE FAMILY — the pure functions, then the MonetCore wrapper that funnels through them.
    expect(() => evaluateGate(db, { actionContext: "Bash:npm install", circle: BREADTH_CIRCLE })).toThrow(message);
    expect(() => gateQuery(db, { actionContext: "Bash:npm install", circle: BREADTH_CIRCLE })).toThrow(message);
    expect(() => c.gate({ actionContext: "Bash:npm install", circle: BREADTH_CIRCLE })).toThrow(message);

    // THE RECOGNIZED-MATCHER FAMILY — same shape, same three levels.
    expect(() => evaluateStageLookup(db, { stage: "npm install", circle: BREADTH_CIRCLE })).toThrow(message);
    expect(() => standaloneStageLookup(db, { stage: "npm install", circle: BREADTH_CIRCLE })).toThrow(message);
    expect(() => c.stageLookup({ stage: "npm install", circle: BREADTH_CIRCLE })).toThrow(message);

    // THE OFFLINE EVALUATOR — no shared internal to funnel through, checked directly.
    const mirror = c.materializeGateMirror(join(mkTmp(), "s.json")).sidecar;
    expect(() => evaluateGateFromMirror(mirror, { actionContext: "Bash:npm install", circle: BREADTH_CIRCLE })).toThrow(message);

    // THE CURATION FAMILY (post-merge review round, item 2) — round 6's OWN sweep missed these: NOT
    // because they are a different mechanism, but because `gateStats` restated
    // `(b.circle = ? OR b.circle = '*')` inline (twice) instead of the shared `RULE_LIVENESS_WHERE`
    // constant, so it never surfaced in a search for that constant's own call sites, and
    // `liveStageIndex` is reached from `MonetCore.prewarm()` after `resolveCircle`, which by design
    // passes an explicit '*' straight through rather than refusing it (see `assertQueryableCircle`'s
    // own comment).
    expect(() => gateStats(db, { circle: BREADTH_CIRCLE, windowDays: 30 })).toThrow(message);
    expect(() => c.gateStats(BREADTH_CIRCLE)).toThrow(message);
    expect(() => liveStageIndex(db, BREADTH_CIRCLE)).toThrow(message);
    // MonetCore.prewarm() reaches liveStageIndex, while overview() reaches gateStats; verify both
    // public entrances directly rather than only the shared internal functions.
    expect(() => c.prewarm(BREADTH_CIRCLE)).toThrow(message);
    expect(() => c.overview(BREADTH_CIRCLE)).toThrow(message);

    // AN ORDINARY CIRCLE IS UNAFFECTED — the refusal is specific to '*', not a general regression.
    // Stages are store-global (matched regardless of circle), so the stage itself still hits — the
    // circle scoping shows up in `rules`, not `silence` (the stage-hit-no-rules case, not a miss).
    expect(c.gate({ actionContext: "Bash:npm install", circle: "an-ordinary-circle" })).toMatchObject({ silence: false, rules: [] });
    expect(() => evaluateGateFromMirror(mirror, { actionContext: "Bash:npm install", circle: "default" })).not.toThrow();
    expect(() => c.gateStats("an-ordinary-circle")).not.toThrow();
    expect(() => c.prewarm("an-ordinary-circle")).not.toThrow();
    c.close();
  });
});

describe("gateQuery", () => {
  it("silence when nothing matches, and a stage with no rules is NOT silence", async () => {
    const c = core();
    expect(c.gate({ actionContext: "Bash:git status" })).toMatchObject({ stage: null, stages: [], rules: [], silence: true, source: "live" });

    await c.declare({ species: "stage", stage: "terraform apply", patterns: ["terraform apply"] });
    const empty = c.gate({ actionContext: "Bash:terraform apply -auto-approve" });
    // The projection hook: "stage X, no cached rules — skeleton applies."
    expect(empty).toMatchObject({ silence: false, rules: [] });
    expect(empty.stage).toMatchObject({ name: "terraform apply" });
    c.close();
  });

  it("delivers the rule with the reason that earns compliance", async () => {
    const c = core();
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule",
      rule: { stage: "git force push", instance: "Bash:git push --force origin main", reason: "it destroys teammates' commits", ...AGENT_RULE },
    });
    const fired = c.gate({ actionContext: "Bash:cd /repo && git push --force origin dev" });
    expect(fired.silence).toBe(false);
    expect(fired.rules).toEqual([{
      conceptId: rule.conceptId,
      text: "Never force-push to a shared branch",
      reason: "it destroys teammates' commits",
      // Present and FALSE on every ordinary rule. This assertion is `toEqual`, so it pins the whole
      // delivered shape — which is how the field's arrival was noticed here rather than by a
      // consumer discovering an undefined at the moment it wanted to render a deny.
      reasonMissing: false,
      severity: "advisory",
      scope: "agent",
      modelTag: "test-model-1",
      origin: "correction",
      stageId: c.ruleBinding(rule.conceptId)!.stage_id,
    }]);
    c.close();
  });

  it("unions the rules of EVERY matched stage, blocking first then oldest first", async () => {
    const c = core();
    // A broad stage and a narrow one that both match the same action.
    await c.declare({ species: "stage", stage: "git push", patterns: ["git push"] });
    await c.declare({ species: "stage", stage: "git force push", patterns: ["git push --force"] });
    const broad = await c.store("Pull before you push.", { kind: "rule", rule: { stage: "git push", ...AGENT_RULE } });
    const narrow = await c.store("Never force-push to a shared branch.", { kind: "rule", rule: { stage: "git force push", ...AGENT_RULE } });
    const deny = await c.declare({
      species: "rule", stage: "git force push", content: "Never force-push to main.", severity: "blocking",
      reason: "a rewritten history cannot be recovered from a teammate's clone", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");

    const fired = c.gate({ actionContext: "Bash:git push --force origin main" });
    expect(fired.stages.map((s) => s.name)).toEqual(["git push", "git force push"]);
    // Blocking first — a deny must be the first thing an agent reads — then birth order.
    expect(fired.rules.map((r) => r.conceptId)).toEqual([deny.conceptId, broad.conceptId, narrow.conceptId]);
    expect(fired.rules[0]!.severity).toBe("blocking");

    // The narrow stage alone answers the narrow action's sibling.
    expect(c.gate({ actionContext: "Bash:git push origin main" }).rules.map((r) => r.conceptId)).toEqual([broad.conceptId]);
    c.close();
  });

  it("is circle-scoped: a rule in circle A never fires in circle B", async () => {
    const c = core();
    const inA = await c.store("Never force-push to a shared branch.", {
      circle: "a", kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    // The STAGE is store-global — the same action in both circles — but the RULE is not.
    expect(c.gate({ actionContext: "Bash:git push --force", circle: "a" }).rules.map((r) => r.conceptId)).toEqual([inA.conceptId]);
    const inB = c.gate({ actionContext: "Bash:git push --force", circle: "b" });
    expect(inB.rules).toEqual([]);
    expect(inB.silence).toBe(false); // the stage still matched; only the rule is elsewhere
    c.close();
  });

  it("never re-injects a superseded rule, and delivers its successor instead", async () => {
    const c = core();
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    expect(c.gate({ actionContext: "Bash:git push --force" }).rules.map((r) => r.conceptId)).toEqual([rule.conceptId]);

    const successor = await c.store("Force-push is fine on your own branch; never on a shared one.", {
      kind: "correction", attachTo: rule.conceptId,
    });
    const after = c.gate({ actionContext: "Bash:git push --force" });
    expect(after.rules.map((r) => r.conceptId)).toEqual([successor.conceptId]);
    // The old rule is still there, still findable — it is the history and the impeachment evidence.
    expect((await c.getConcept(rule.conceptId))!.status).toBe("active");
    c.close();
  });

  it("drops a retired rule, and announces a derived rule's parent principle", async () => {
    const c = core();
    const principle = await c.store("Irreversible acts get a confirmation.", { kind: "insight" });
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    c.addLifecycleEdge({ family: "derivation", srcConceptId: principle.conceptId, dstConceptId: rule.conceptId, bornOf: "extraction" });
    expect(c.gate({ actionContext: "Bash:git push --force" }).rules[0]!.projectedFromPrincipleId).toBe(principle.conceptId);

    c.retireConcept(rule.conceptId);
    expect(c.gate({ actionContext: "Bash:git push --force" }).rules).toEqual([]);
    c.close();
  });

  it("flips a stage from unverified to verified on its FIRST fire, rules or not", async () => {
    const c = core();
    await c.declare({ species: "stage", stage: "terraform apply", patterns: ["terraform apply"] });
    expect(c.stages()[0]!.verified).toBe(false);
    c.gate({ actionContext: "Bash:terraform plan" });
    expect(c.stages()[0]!.verified).toBe(false); // no match, no proof
    c.gate({ actionContext: "Bash:terraform apply -auto-approve" });
    expect(c.stages()[0]!.verified).toBe(true); // the pattern matched something real
    c.close();
  });

  it("asks no model and no embedder: the firing path is answerable with the embedder removed", async () => {
    const c = core();
    await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    // Sabotage the embedder: anything on the firing path that reached for it would throw.
    (c as unknown as { embedder: { embed: () => never } }).embedder = {
      embed: () => { throw new Error("the gate must never embed"); },
    } as never;
    expect(c.gate({ actionContext: "Bash:git push --force" }).rules).toHaveLength(1);
    c.close();
  });
});

// ---------------------------------------------------------------------------
// instrumentation
// ---------------------------------------------------------------------------
describe("gate instrumentation", () => {
  it("logs one row per query — silences included, because silence is the denominator", async () => {
    const c = core();
    await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    c.gate({ actionContext: "Bash:git push --force origin main" });
    c.gate({ actionContext: "Bash:git status" });
    c.gate({ actionContext: "Read:/etc/hosts" });

    const rows = raw(c).prepare(`SELECT * FROM gate_events ORDER BY id`).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      action_context: "Bash:git push --force origin main",
      rule_count: 1,
      max_severity: "advisory",
      circle: "default",
    });
    expect(rows[0]!.matched_stage_id).toBe(c.stages()[0]!.id);
    expect(rows[1]).toMatchObject({ matched_stage_id: null, rule_count: 0, max_severity: null });

    const stats = c.gateStats();
    expect(stats).toMatchObject({ windowDays: 30, fires: 1, silences: 2, delivered: 1, windowTotal: 3, total: 3 });
    expect(stats.byStage).toEqual([{ stageId: c.stages()[0]!.id, stageName: "git force push", fires: 1 }]);
    expect(stats.unverifiedPatterns).toEqual([]); // the one stage fired, so it is verified
    c.close();
  });

  it("lists the dead patterns — a stage authored from a name that has never matched anything", async () => {
    const c = core();
    await c.declare({ species: "stage", stage: "some action nobody performs", patterns: ["frobnicate --hard"] });
    const stats = c.gateStats();
    expect(stats.unverifiedPatterns).toEqual([{
      stageId: c.stages()[0]!.id,
      stageName: "some action nobody performs",
      origin: "declaration",
      patterns: ["*: frobnicate --hard"],
    }]);
    c.close();
  });

  it("surfaces in overview and in the rendered curation view", async () => {
    const c = core();
    await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    await c.declare({ species: "stage", stage: "a dead gate", patterns: ["frobnicate --hard"] });
    c.gate({ actionContext: "Bash:git push --force origin main" });
    c.gate({ actionContext: "Bash:git status" });

    const ov = c.overview("default");
    expect(ov.gateStats).toMatchObject({ fires: 1, silences: 1, delivered: 1 });
    const rendered = renderOverview(ov, { color: false });
    expect(rendered).toContain("GATE EXCEPTIONS");
    expect(rendered).toContain("2 asked · 1 fires · 1 silences · 0 overflows · 1 delivered");
    expect(rendered).not.toContain("frobnicate --hard");
    c.close();
  });

  it("names the stage that ANSWERED, and counts every stage that matched", async () => {
    const c = core();
    // The broad stage is OLDER, so "first matched" and "highest severity" disagree — which is the
    // only configuration where the distinction is observable.
    await c.declare({ species: "stage", stage: "git push", patterns: ["git push"] });
    await c.declare({ species: "stage", stage: "git force push", patterns: ["git push --force"] });
    const advisory = await c.store("Pull before you push.", { kind: "rule", rule: { stage: "git push", ...AGENT_RULE } });
    const deny = await c.declare({
      species: "rule", stage: "git force push", content: "Never force-push to main.", severity: "blocking",
      reason: "a rewritten history cannot be recovered from a teammate's clone", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");

    const fired = c.gate({ actionContext: "Bash:git push --force origin main" });
    // J2: the stage that produced the DENY, not the one that happens to be oldest. A reader asking
    // "which stage is blocking me" must not be handed the advisory one.
    expect(fired.stage!.name).toBe("git force push");
    expect(fired.stages.map((s) => s.name)).toEqual(["git push", "git force push"]);
    const event = raw(c).prepare(`SELECT * FROM gate_events ORDER BY id DESC LIMIT 1`).get() as { matched_stage_id: string };
    expect(event.matched_stage_id).toBe(fired.stage!.id);

    // J3: byStage counts EVERY matched stage. Counting only the one that answered reports the broad
    // stage as never firing — which is exactly what curation reads as "dead, safe to remove".
    expect(c.gateStats().byStage.map((s) => [s.stageName, s.fires])).toEqual([
      ["git force push", 1], ["git push", 1],
    ]);

    // With no rule to rank by, the projection-hook case falls back to the oldest matched stage.
    // The deny is withdrawn by declaration first — retiring a live one is refused by the chokepoint.
    await withdrawDeny(c, deny.conceptId, "git force push");
    c.retireConcept(deny.conceptId);
    c.retireConcept(advisory.conceptId);
    expect(c.gate({ actionContext: "Bash:git push --force origin main" }).stage!.name).toBe("git push");
    c.close();
  });

  it("record:false writes NOTHING — not an event, and not a verified flip", async () => {
    const c = core();
    await c.declare({ species: "stage", stage: "terraform apply", patterns: ["terraform apply"] });
    const fired = c.gate({ actionContext: "Bash:terraform apply -auto-approve", record: false });
    expect(fired.stages).toHaveLength(1); // it really did match
    expect(raw(c).prepare(`SELECT COUNT(*) AS n FROM gate_events`).get()).toEqual({ n: 0 });
    expect(raw(c).prepare(`SELECT COUNT(*) AS n FROM gate_event_stages`).get()).toEqual({ n: 0 });
    // The dead-pattern watchlist exists to say "this has never matched anything REAL". A measured
    // or previewed match is not a real action, so it must not silence the watchlist.
    expect(c.stages()[0]!.verified).toBe(false);
    expect(c.gateStats().unverifiedPatterns).toHaveLength(1);

    c.gate({ actionContext: "Bash:terraform apply -auto-approve" });
    expect(c.stages()[0]!.verified).toBe(true);
    c.close();
  });

  it("records a stored excerpt as truncated WITHOUT that ever having limited the match", async () => {
    const c = core();
    await c.declare({ species: "stage", stage: "rm -rf", patterns: ["Bash:rm -rf"] });
    c.gate({ actionContext: `Bash:rm -rf /tmp/x` });
    // Long enough to exceed what the event row stores, nowhere near the refusal threshold — and the
    // deny hidden at the far end still fires. `truncated` is a note about the EXCERPT, not coverage.
    const fired = c.gate({ actionContext: `Bash:${"x".repeat(70_000)} && rm -rf /tmp/y` });
    expect(fired.rules.length + fired.stages.length).toBeGreaterThan(0);
    expect(fired.overflow).toBe(false);
    const rows = raw(c).prepare(`SELECT truncated, overflow, matched_stage_id FROM gate_events ORDER BY id`)
      .all() as Array<{ truncated: number; overflow: number; matched_stage_id: string | null }>;
    expect(rows.map((r) => r.truncated)).toEqual([0, 1]);
    expect(rows.map((r) => r.overflow)).toEqual([0, 0]);
    expect(rows[1]!.matched_stage_id).not.toBeNull();
    c.close();
  });

  it("keeps overview READ-ONLY: reading gate stats fires no gate", async () => {
    const c = core();
    await c.store("Never force-push.", { kind: "rule", rule: { stage: "git force push", ...AGENT_RULE } });
    c.overview("default");
    c.overview("default");
    expect(raw(c).prepare(`SELECT COUNT(*) AS n FROM gate_events`).get()).toEqual({ n: 0 });
    c.close();
  });
});

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------
describe("gate substrate sync", () => {
  it("carries stages and bindings across export → graft, and dedupes on a replay", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    const rule = await src.store("Never force-push to a shared branch.", {
      kind: "rule",
      rule: { stage: "git force push", instance: "Bash:git push --force origin main", reason: "destroys commits", ...AGENT_RULE },
    });

    const payload = src.exportDelta(0);
    expect(payload.schemaVersion).toBe(15);
    expect(payload.stages?.map((s) => s.name)).toEqual(["git force push"]);
    expect(payload.ruleBindings?.map((b) => b.concept_id)).toEqual([rule.conceptId]);

    const result = await dst.graftRows(payload);
    expect(result.inserted.stages).toBe(1);
    expect(result.inserted.rule_bindings).toBe(1);

    // The gate answers identically on the receiver — the whole point of replicating the registry.
    const fired = dst.gate({ actionContext: "Bash:git push --force origin main" });
    expect(fired.rules).toMatchObject([{ conceptId: rule.conceptId, reason: "destroys commits", severity: "advisory" }]);

    const replay = await dst.graftRows(payload);
    expect(replay.inserted.stages).toBe(0);
    expect(replay.inserted.rule_bindings).toBe(0);
    expect(replay.skipped.stages).toBe(1);
    expect(replay.skipped.rule_bindings).toBe(1);

    // ...and the receiver re-exports them onward.
    expect(dst.exportDelta(0).stages?.map((s) => s.name)).toEqual(["git force push"]);
    src.close();
    dst.close();
  });

  /**
   * A GRAFTED DERIVATION EDGE IS MIRROR CONTENT TOO (review fix — Codex 5-B round 2, R2-1).
   * `GateMirrorEntry` carries `projectedFromPrincipleId` as of slice 5-B (D4), so an edge landing on
   * an ALREADY-BOUND rule changes what the mirror would write while nothing about the binding moves.
   * The three LOCAL entrances into the derivation family (addLifecycleEdge, recordProjectionEdge,
   * ratifySkeletonMembership) all bump for that; the graft loop bumped only for `supersession`, so a
   * relayed projection/ratification edge left graftRows' closing `refreshGateSidecar()` treating a
   * parentless mirror as current while the live gate reported the parent.
   */
  it("bumps the generation when a grafted DERIVATION edge lands on a bound rule, so the mirror's parent field cannot go stale", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const src = core({ syncDeviceId: "machine-a" });
    const dst = new MonetCore(":memory:", {
      tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-b", gateSidecarPath: path,
    });
    const declared = await src.declare({ species: "principle", content: "Irreversible acts get a confirmation.", declaredBy: "john" });
    if (declared.species !== "principle") throw new Error("unreachable");
    const rule = await src.store("Confirm the target namespace before deleting a release.", {
      kind: "rule", rule: { stage: "helm delete", instance: "Bash:helm delete my-release", scope: "domain" },
    });

    // ROUND 1 — the rule, its stage and its binding arrive with NO parent yet. The mirror on disk is
    // correct at this moment, and parentless.
    const first = src.exportDelta(0);
    dst.graftRows(first);
    const parentless = JSON.parse(readFileSync(path, "utf8")) as GateMirror;
    expect(parentless.entries.find((e) => e.conceptId === rule.conceptId)!.projectedFromPrincipleId).toBeUndefined();
    const before = dst.sidecarGeneration();

    // ROUND 2 — ONLY a derivation edge is new. Every other row in this payload landed identically in
    // round 1 and is skipped, so any bump at all comes from the edge.
    const edge = src.addLifecycleEdge({
      family: "derivation", srcConceptId: declared.conceptId, dstConceptId: rule.conceptId,
      bornOf: "ratification", eventRef: src.getRatifications(declared.conceptId)[0]!.id,
    });
    const second = dst.graftRows(src.exportDelta(0));
    expect(second.inserted.lifecycle_edges).toBe(1);
    expect(dst.getLifecycleEdges(rule.conceptId, { direction: "in", family: "derivation" }).map((e) => e.id)).toEqual([edge.id]);

    // THE LIVE GATE ALREADY SAYS IT — and the file must not disagree.
    expect(dst.gate({ actionContext: "Bash:helm delete my-release" }).rules[0]!.projectedFromPrincipleId)
      .toBe(declared.conceptId);
    expect(dst.sidecarGeneration()).toBeGreaterThan(before);
    const refreshed = JSON.parse(readFileSync(path, "utf8")) as GateMirror;
    expect(refreshed.entries.find((e) => e.conceptId === rule.conceptId)!.projectedFromPrincipleId)
      .toBe(declared.conceptId);
    expect(evaluateGateFromMirror(refreshed, { actionContext: "Bash:helm delete my-release", circle: "default" }).rules[0]!.projectedFromPrincipleId)
      .toBe(declared.conceptId);
    src.close();
    dst.close();
  });

  it("does NOT carry gate_events — one machine's action stream is not the other's", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    await src.store("Never force-push.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    src.gate({ actionContext: "Bash:git push --force origin main" });
    src.gate({ actionContext: "Bash:git status" });
    expect(src.gateStats().windowTotal).toBe(2);

    const payload = src.exportDelta(0);
    expect(payload).not.toHaveProperty("gateEvents");
    expect(JSON.stringify(payload)).not.toContain("git status");
    await dst.graftRows(payload);
    expect(dst.gateStats().windowTotal).toBe(0);
    expect(raw(dst).prepare(`SELECT COUNT(*) AS n FROM gate_events`).get()).toEqual({ n: 0 });
    src.close();
    dst.close();
  });

  it("converges `verified` as a grow-only fact: a peer who never fired cannot un-verify", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    await src.store("Never force-push.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    const unfired = src.exportDelta(0);
    await dst.graftRows(unfired);
    expect(dst.stages()[0]!.verified).toBe(false);

    src.gate({ actionContext: "Bash:git push --force origin main" });
    await dst.graftRows(src.exportDelta(0));
    expect(dst.stages()[0]!.verified).toBe(true);

    // Replaying the OLD (unverified) payload must not take the proof back.
    await dst.graftRows(unfired);
    expect(dst.stages()[0]!.verified).toBe(true);
    src.close();
    dst.close();
  });

  it("relays a binding whose rule concept is retired — that record is what audit reads", async () => {
    const a = core({ syncDeviceId: "machine-a" });
    const b = core({ syncDeviceId: "machine-b" });
    const rule = await a.store("A rule that will be retired on machine A.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    a.retireConcept(rule.conceptId);

    const payload = a.exportDelta(0);
    expect(payload.concepts.map((c) => c.id)).not.toContain(rule.conceptId);
    expect(payload.ruleBindings?.map((x) => x.concept_id)).toEqual([rule.conceptId]);
    const result = await b.graftRows(payload);
    expect(result.inserted.rule_bindings).toBe(1);
    // It arrives dangling and simply never fires — the endpoint is not there to be governed.
    expect(b.gate({ actionContext: "Bash:git push --force origin main" }).rules).toEqual([]);
    a.close();
    b.close();
  });

  /**
   * A DENY THAT CANNOT EXPLAIN ITSELF IS ACCEPTED, FIRED, AND DISCLOSED.
   *
   * Local creation of one is refused, so the only way a store holds one is relay from a peer whose
   * build predates the requirement. Refusing it here for symmetry would be the removal doors 9 and
   * 10 exist to forbid — machine B ending up without a deny machine A has, protection reduced by
   * us, over a missing sentence. So it lands and guards, and every surface that shows the deny says
   * what is missing from it. The promise is unmet for that rule and visibly so, which is
   * survivable; hiding it would make the promise false, which is not.
   */
  const relayReasonlessDeny = async (
    dst: MonetCore,
    opts: { reason?: string | null } = {},
  ): Promise<{ src: MonetCore; conceptId: string; inserted: number }> => {
    const src = core({ syncDeviceId: "machine-a" });
    // Declared legitimately HERE, because this build will not mint one without a reason. Stripping
    // the reason from the exported row is what a peer running the older build relays natively.
    const deny = await src.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking",
      reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    const payload = src.exportDelta(0);
    const bindings = payload.ruleBindings!.map((b) =>
      b.concept_id === deny.conceptId ? { ...b, reason: opts.reason ?? null } : b);
    const result = dst.graftRows({ ...payload, ruleBindings: bindings });
    return { src, conceptId: deny.conceptId, inserted: result.inserted.rule_bindings };
  };

  it("LANDS a relayed deny that carries no reason, fires it, and discloses it on every surface", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const dst = new MonetCore(":memory:", {
      tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-b", gateSidecarPath: path,
    });
    const { src, conceptId, inserted } = await relayReasonlessDeny(dst);

    // ACCEPTED, not skipped-and-counted. This is the assertion the ruling turns on.
    expect(inserted).toBe(1);
    expect(dst.ruleBinding(conceptId)).toMatchObject({ severity: "blocking", reason: null });

    // ...and it GUARDS. A deny that landed but did not fire would be the same protection loss by a
    // quieter route.
    const fired = dst.gate({ actionContext: "Bash:rm -rf /tmp/x" });
    expect(fired.rules).toHaveLength(1);
    expect(fired.rules[0]).toMatchObject({
      conceptId, severity: "blocking", reason: null, reasonMissing: true,
    });

    // The MIRROR says it too — a reader runs when the server is unreachable, which is already the
    // moment a user is least able to go and look the reason up. reasonMissing is not STORED on the
    // entry as of format 4 (computed at read via hasNoReason, the one predicate every surface
    // shares) — evaluateGateFromMirror is that read, so running the mirror through it is what proves
    // the offline surface still discloses this, not merely that the raw JSON carries a reason.
    const mirrored = dst.materializeGateMirror().sidecar;
    const entry = mirrored.entries[0]!;
    expect(entry).toMatchObject({ conceptId, reason: null });
    const offlineFired = evaluateGateFromMirror(mirrored, { actionContext: "Bash:rm -rf /tmp/x", circle: "default" });
    expect(offlineFired.rules[0]).toMatchObject({ conceptId, reason: null, reasonMissing: true });
    // Present in the FILE, not merely in the return value: the file is what a reader actually opens.
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as GateMirror;
    expect(onDisk.format).toBe(4);
    expect(onDisk.entries[0]).toMatchObject({ conceptId, reason: null });

    // ...and CURATION gets a REPAIR QUEUE, not an alarm: `stageName` and `title` are exactly the
    // `stage` and `content` the repairing declaration below takes, so nothing has to be gone and
    // found first.
    expect(dst.gateStats("default").unexplainedDenies).toEqual([
      { conceptId, title: "Never delete a tree unattended", stageName: "rm -rf" },
    ]);

    // The pairing that makes this coherent: what relay accepted, local declaration still refuses.
    // Relay is the only way such a row exists, which is why disclosure is the answer and rejection
    // is not.
    await expect(dst.declare({
      species: "rule", stage: "rm -rf", content: "Some other deny.", severity: "blocking", ...AGENT_RULE,
    })).rejects.toThrow(/blocking rule requires `reason`/);

    src.close();
    dst.close();
  });

  /**
   * EVERY SURFACE AGREES ON WHAT COUNTS AS BLANK, including the one that nearly did not.
   *
   * bindRule normalizes a blank to NULL locally, but graft writes the peer's value straight through,
   * so any of these can arrive intact. The curation list once asked this question in SQL, as
   * `TRIM(reason) = ''` — and SQLite's one-argument TRIM strips ORDINARY SPACES ONLY. A relayed
   * "\t" therefore marked the delivered rule and the sidecar entry while the list came back EMPTY
   * and the overview's repair section stayed suppressed: a bare deny firing, with nothing anywhere
   * telling the human it existed. Tabs and newlines are here because that is the case two dialects'
   * idea of whitespace disagreed on, and " " is here because it is the one they agreed on — a test
   * that only covered the agreeing case is what let the disagreement ship.
   */
  for (const [label, blank] of [["tab", "\t"], ["newline", "\n"], ["one space", " "], ["several spaces", "   "]] as const) {
    it(`treats a relayed ${label} reason as no reason, on the gate, the mirror, the list AND the view`, async () => {
      const dir = mkTmp();
      const path = join(dir, "gate-sidecar.json");
      const dst = new MonetCore(":memory:", {
        tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-b", gateSidecarPath: path,
      });
      const { src, conceptId } = await relayReasonlessDeny(dst, { reason: blank });
      // Stored verbatim: graft does not normalize a peer's value, which is exactly why every READER
      // has to ask the same question rather than trusting the column to be canonical.
      expect(dst.ruleBinding(conceptId)!.reason).toBe(blank);

      expect(dst.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules[0]).toMatchObject({ reasonMissing: true });
      const mirrored = dst.materializeGateMirror().sidecar;
      expect(evaluateGateFromMirror(mirrored, { actionContext: "Bash:rm -rf /tmp/x", circle: "default" }).rules[0])
        .toMatchObject({ reasonMissing: true });
      expect(dst.gateStats("default").unexplainedDenies).toMatchObject([{ conceptId, stageName: "rm -rf" }]);
      const rendered = renderOverview(dst.overview("default"), { color: false });
      expect(rendered).toContain("repair [");
      expect(rendered).toContain("rm -rf  ·  Never delete a tree unattended");
      src.close();
      dst.close();
    });
  }

  /**
   * A DENY THAT VANISHES WITH AN EXCEPTION is worse than a deny that misinforms, and it was one
   * `UPDATE` away. SQLite stores whatever a writer hands the column, so a malformed peer could leave
   * a NUMBER in `reason`; `hasNoReason` then called `.trim()` on it and threw, taking out the
   * matching gate query, the sidecar rebuild and the gate-stats read together — live AND offline
   * delivery for that rule, which is precisely the pair the mirror exists to keep independent.
   */
  const corruptReason = (c: MonetCore, conceptId: string, value: unknown) =>
    raw(c).prepare(`UPDATE rule_bindings SET reason = ? WHERE concept_id = ?`).run(value, conceptId);

  for (const [label, value] of [
    ["a blob", Buffer.from([0xff, 0xfe, 0x00])],
    ["an empty blob", Buffer.alloc(0)],
  ] as const) {
    it(`survives ${label} already stored in reason, on every read path, and discloses it`, async () => {
      const dir = mkTmp();
      const path = join(dir, "gate-sidecar.json");
      const c = new MonetCore(":memory:", {
        tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, syncDeviceId: "machine-a",
      });
      const deny = await c.declare({
        species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
        content: "Never delete a tree unattended.", severity: "blocking",
        reason: "there is no undo", ...AGENT_RULE,
      });
      if (deny.species !== "rule") throw new Error("unreachable");

      // Written UNDER the write path, the way a bad row actually exists: already on disk, unsendable
      // back. Preflight protects new arrivals; only the predicate protects what is already here.
      corruptReason(c, deny.conceptId, value);

      // THE DENY STILL FIRES. Not throwing is the whole point — a rule whose read path raises is a
      // rule that stops governing.
      const fired = c.gate({ actionContext: "Bash:rm -rf /tmp/x" });
      expect(fired.rules).toHaveLength(1);
      expect(fired.rules[0]).toMatchObject({ severity: "blocking", reasonMissing: true });

      // ...and it lands in the disclosure this branch already built for a deny that cannot explain
      // itself. Nothing special-cases a number, because it is not a special case: it is not an
      // explanation, so the rule has none. The offline evaluator reaches the same disclosure off the
      // SAME mirror, through the SAME hasNoReason predicate — reasonMissing is computed, not stored.
      const mirrored = c.materializeGateMirror().sidecar;
      const offlineFired = evaluateGateFromMirror(mirrored, { actionContext: "Bash:rm -rf /tmp/x", circle: "default" });
      expect(offlineFired.rules[0]).toMatchObject({ reasonMissing: true });
      expect(c.gateStats("default").unexplainedDenies).toMatchObject([{ conceptId: deny.conceptId }]);
      expect(renderOverview(c.overview("default"), { color: false })).toContain("repair [");
      // Delivered as NULL, not as the raw value: `reason` is declared `string | null`, and handing a
      // caller a Buffer moves the crash from this module into theirs. The mirror stays readable JSON
      // for the same reason.
      expect(fired.rules[0]!.reason).toBeNull();
      expect(mirrored.entries[0]!.reason).toBeNull();
      c.close();
    });
  }

  it("treats a NUMBER in reason as the text SQLite actually stored, not as corruption", async () => {
    const c = core();
    const deny = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking",
      reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");

    // WORTH PINNING BECAUSE IT IS COUNTERINTUITIVE, and it is the assumption that made a number look
    // like the crash vector. The column is `reason TEXT`, and TEXT AFFINITY CONVERTS a bound number
    // on the way in — so this row comes back as the string "42.0", not as 42. `.trim()` works, the
    // read paths never saw it, and treating it as absent would be marking a present (if silly)
    // reason as missing. Blobs are the values affinity does NOT convert, which is why they are the
    // case above.
    corruptReason(c, deny.conceptId, 42);
    expect(c.ruleBinding(deny.conceptId)!.reason).toBe("42.0");
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules[0]).toMatchObject({
      severity: "blocking", reason: "42.0", reasonMissing: false,
    });
    expect(c.gateStats("default").unexplainedDenies).toEqual([]);
    c.close();
  });

  it("lets an ordinary declaration REPAIR a corrupt reason, rather than locking the rule", async () => {
    const c = resolvingCore();
    const deny = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking",
      reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    corruptReason(c, deny.conceptId, Buffer.from([0xff, 0xfe]));

    // bindRule reads `existing.reason` off disk when the caller OMITS one, so the bare `.trim()`
    // threw HERE too. A restatement that omits the reason is still refused — resolution reads the
    // corrupt value as absent, and a blocking rule may not be left without one — but it is refused
    // by the NAMED guard with the sentence that says what to do, not by a TypeError from three
    // frames down. A corrupt row must never become a rule nobody can repair, and "the tool crashed"
    // is not a repair instruction.
    await expect(c.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a tree unattended.", ...AGENT_RULE,
    })).rejects.toThrow(/blocking rule requires `reason`/);

    const repaired = await c.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a tree unattended.",
      reason: "there is genuinely no undo", ...AGENT_RULE,
    });
    if (repaired.species !== "rule") throw new Error("unreachable");
    expect(repaired.conceptId).toBe(deny.conceptId);
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules[0]).toMatchObject({
      severity: "blocking", reason: "there is genuinely no undo", reasonMissing: false,
    });
    expect(c.gateStats("default").unexplainedDenies).toEqual([]);
    c.close();
  });

  it("REFUSES a relayed binding whose reason is not text, at the boundary", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    const deny = await src.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking",
      reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    const payload = src.exportDelta(0);

    // A reason is text or it is absent; there is no third thing. This dies at the boundary rather
    // than becoming a permanent resident every future reader has to be careful about.
    for (const bad of [42, { text: "nope" }, ["nope"], true]) {
      expect(() => dst.graftRows({
        ...payload,
        ruleBindings: payload.ruleBindings!.map((b) => ({ ...b, reason: bad as unknown as string })),
      }), JSON.stringify(bad)).toThrow(/non-string reason/);
    }
    expect(dst.ruleBinding(deny.conceptId)).toBeNull();

    // null still relays — absence is legal, and refusing it would drop a deny the peer has.
    dst.graftRows({ ...payload, ruleBindings: payload.ruleBindings!.map((b) => ({ ...b, reason: null })) });
    expect(dst.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules[0]).toMatchObject({ reasonMissing: true });
    src.close();
    dst.close();
  });

  it("REFUSES a relayed stage whose name exceeds the creation bound — and grafts one exactly at it", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    const atMax = "s".repeat(STAGE_NAME_MAX_CHARS);
    await src.declare({
      species: "rule", stage: atMax, patterns: ["Bash:frob"],
      content: "Guidance at the boundary length.", severity: "advisory", ...AGENT_RULE,
    });
    const payload = src.exportDelta(0);

    // upsertStage is the only minter and refuses past the bound, so an over-length name can only
    // arrive by relay — the same lattice as the non-string reason below: no honest peer holds one,
    // and letting it land would strand a stage the index advertises but the lookup's input
    // boundary refuses by name.
    const tampered = {
      ...payload,
      stages: payload.stages!.map((s) => ({ ...s, name: `${s.name}!` })),
    };
    expect(() => dst.graftRows(tampered)).toThrow(/-character name \(max /);

    // At the bound, parity with creation: it grafts, and the index advertises what lookup accepts.
    dst.graftRows(payload);
    expect(dst.stageLookup({ stage: atMax }).matched).toBe(true);
    src.close();
    dst.close();
  });

  it("REFUSES a relayed stage whose name is non-canonical — naming both spellings; a canonical graft's advertised name round-trips to a stageLookup HIT (Codex round 3, item 3)", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    await src.declare({
      species: "rule", stage: "Git Force Push", patterns: ["Bash:git push --force"],
      content: "Guidance for a canonical stage.", severity: "advisory", ...AGENT_RULE,
    });
    const payload = src.exportDelta(0);

    // upsertStage stores NORMALIZED names (trimmed, whitespace-collapsed, lowercased), so a genuine
    // exportDelta already carries the normalized form ("git force push") — never the raw display
    // spelling declare() was called with. A non-canonical name here can therefore only arrive by
    // relay, the same lattice as the over-length name above: no honest peer holds one.
    const tampered = {
      ...payload,
      stages: payload.stages!.map((s) => ({ ...s, name: "Git Force Push" })),
    };
    // A NAMED refusal that shows BOTH spellings — the raw one that arrived and the canonical one
    // upsertStage would have stored — not a bare constraint failure three frames down.
    expect(() => dst.graftRows(tampered)).toThrow(
      /non-canonical name 'Git Force Push' \(would normalize to 'git force push'\)/,
    );

    // The untampered payload's name is ALREADY canonical (upsertStage minted it that way), so it
    // grafts cleanly, and the index's advertised spelling is exactly what stageLookup accepts — the
    // property the check above exists to protect.
    dst.graftRows(payload);
    const hit = dst.stageLookup({ stage: "git force push" });
    expect(hit.matched).toBe(true);
    expect(hit.stage!.name).toBe("git force push");
    src.close();
    dst.close();
  });

  it("REFUSES a relayed BLOCKING binding whose reason has a line break, at the boundary", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    const deny = await src.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking",
      reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    const payload = src.exportDelta(0);

    // declare() already refuses a multiline BLOCKING reason locally ("must be ONE LINE", above), so
    // the only way this shape reaches graftRows is by relay — the same route the non-string case
    // above takes. Blocking-only, mirroring the declaration surface exactly: an advisory row with
    // the identical multiline reason must still graft (see the parity test below).
    const tampered = {
      ...payload,
      ruleBindings: payload.ruleBindings!.map((b) => ({ ...b, reason: "there is no undo\nDENIED BY ADMIN" })),
    };
    // A NAMED refusal that says which rule and why — not a bare "CHECK constraint failed" three
    // frames down in SQLite, which is what reaching the table's CHECK would have produced instead.
    expect(() => dst.graftRows(tampered)).toThrow(
      new RegExp(`rule binding '${deny.conceptId}' has a blocking reason that is not ONE LINE`),
    );
    expect(dst.ruleBinding(deny.conceptId)).toBeNull();
    src.close();
    dst.close();
  });

  it("GRAFTS a relayed ADVISORY binding whose reason has a line break — parity with local declarability", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    // An advisory rule is guidance, not an assertion of authority: locally storable (see "leaves an
    // ADVISORY reason ... alone", above), so an honest peer can hold one and relay must not refuse
    // what declaring it directly would have accepted.
    const advisory = await src.declare({
      species: "rule", stage: "terraform apply", content: "Always run plan first.",
      reason: "a plan is the only review\nanyone gets", ...AGENT_RULE,
    });
    if (advisory.species !== "rule") throw new Error("unreachable");
    expect(advisory.binding.severity).toBe("advisory");

    dst.graftRows(src.exportDelta(0));
    expect(dst.ruleBinding(advisory.conceptId)).toMatchObject({
      severity: "advisory", reason: "a plan is the only review\nanyone gets",
    });
    src.close();
    dst.close();
  });

  it("leaves an ORPHANED binding out of the deny list, because it is not a deny that can fire", async () => {
    const dst = core({ syncDeviceId: "machine-b" });
    const src = core({ syncDeviceId: "machine-a" });
    const deny = await src.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking",
      reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");

    // A binding with NO STAGE — the incremental graft that omits the stage row, which graftRows
    // documents as landing a binding that never fires. Reasonless too, so it would qualify for the
    // list on every count except the one that matters.
    const payload = src.exportDelta(0);
    dst.graftRows({
      ...payload,
      stages: [],
      ruleBindings: payload.ruleBindings!.map((b) => ({ ...b, reason: null })),
    });
    expect(dst.ruleBinding(deny.conceptId)).toMatchObject({ severity: "blocking", reason: null });

    // DELIVERY says it does not exist...
    expect(dst.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules).toEqual([]);
    expect(dst.materializeGateMirror(join(mkTmp(), "s.json")).sidecar.entries).toEqual([]);
    // ...so DISCLOSURE must not say it does. Naming it here told the user to redeclare a rule whose
    // redeclaration would CREATE the missing stage and change what the store does — a repair queue
    // giving advice that alters behaviour rather than restoring it.
    expect(dst.gateStats("default").unexplainedDenies).toEqual([]);
    expect(renderOverview(dst.overview("default"), { color: false })).not.toContain("repair [");

    // And once the stage lands, the SAME binding is a live reasonless deny on every surface at once.
    dst.graftRows(payload);
    expect(dst.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules[0]).toMatchObject({ reasonMissing: true });
    expect(dst.gateStats("default").unexplainedDenies).toMatchObject([{ conceptId: deny.conceptId }]);
    src.close();
    dst.close();
  });

  it("does NOT mark a reason that merely contains whitespace around real words", async () => {
    const dst = core({ syncDeviceId: "machine-b" });
    // The predicate asks "is there nothing here", not "is there whitespace here". A padded reason is
    // a reason: it renders, it explains the deny, and marking it would put a rule on the repair
    // queue that has nothing to repair.
    const { src, conceptId } = await relayReasonlessDeny(dst, { reason: "  there is no undo  " });
    expect(dst.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules[0]).toMatchObject({
      reason: "  there is no undo  ", reasonMissing: false,
    });
    expect(dst.gateStats("default").unexplainedDenies).toEqual([]);
    expect(renderOverview(dst.overview("default"), { color: false })).not.toContain("repair [");
    expect(conceptId).toBeTruthy();
    src.close();
    dst.close();
  });

  it("REPAIRS a relayed reasonless deny through an ordinary local declaration", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const dst = new MonetCore(":memory:", { syncDeviceId: "machine-b", gateSidecarPath: path });
    const { src, conceptId } = await relayReasonlessDeny(dst);
    expect(dst.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules[0]).toMatchObject({ reasonMissing: true });

    // No migration and no backfill: the repair is a human stating the sentence they owe, through
    // the same declaration surface as any other. `resolvingCore`-style resolution lands it on the
    // relayed concept because the content is identical.
    const repaired = await dst.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a tree unattended.",
      reason: "there is no undo", ...AGENT_RULE,
    });
    if (repaired.species !== "rule") throw new Error("unreachable");
    expect(repaired.conceptId).toBe(conceptId);

    // Severity was never named and is preserved — the repair supplies the reason WITHOUT the human
    // having to re-assert deny power they never withdrew.
    const fired = dst.gate({ actionContext: "Bash:rm -rf /tmp/x" });
    expect(fired.rules[0]).toMatchObject({
      severity: "blocking", reason: "there is no undo", reasonMissing: false,
    });
    const mirrored = dst.materializeGateMirror().sidecar;
    expect(mirrored.entries[0]).toMatchObject({ reason: "there is no undo" });
    expect(evaluateGateFromMirror(mirrored, { actionContext: "Bash:rm -rf /tmp/x", circle: "default" }).rules[0])
      .toMatchObject({ reason: "there is no undo", reasonMissing: false });
    expect(dst.gateStats("default").unexplainedDenies).toEqual([]);
    src.close();
    dst.close();
  });

  it("NAMES the reasonless deny in the rendered curation view, on a store nobody has asked", async () => {
    const dst = core({ syncDeviceId: "machine-b" });
    const { src } = await relayReasonlessDeny(dst);

    // NOT ONE GATE QUERY, and no dead patterns — so every condition that normally brings the GATES
    // section into view is false. That is exactly the store where nobody finds this on their own,
    // which is why the list joins the suppression condition rather than riding inside it. The
    // section's own comment is the standard being met here: a JSON field on the MCP response does
    // not discharge a disclosure whose whole purpose is that a human sees it.
    const ov = dst.overview("default");
    expect(ov.gateStats).toMatchObject({ windowTotal: 0 });
    expect(ov.gateStats!.unexplainedDenies).toHaveLength(1);
    const rendered = renderOverview(ov, { color: false });
    expect(rendered).toContain("GATE EXCEPTIONS");
    expect(rendered).toContain("repair [");
    expect(rendered).toContain("rm -rf  ·  Never delete a tree unattended");
    // ...and the ID, so the exact rule can be FETCHED before it is redeclared. Titles are a concept's
    // first line, not its content, and nothing makes them unique — repairing by title alone is how
    // somebody fixes the wrong rule. Leads the row so truncation can never take it.
    const conceptId = dst.gateStats("default").unexplainedDenies[0]!.conceptId;
    expect(rendered).toContain(`[${conceptId.slice(0, 8)}] rm -rf  ·  Never delete a tree unattended`);
    src.close();
    dst.close();
  });

  it("summarizes rather than becoming a wall of text when many denies arrive unexplained", async () => {
    const dst = core({ syncDeviceId: "machine-b" });
    const src = core({ syncDeviceId: "machine-a" });
    // Seven entries remain compact in the overview's source-capped exception queue.
    for (let i = 0; i < 7; i++) {
      await src.declare({
        species: "rule", stage: `gate-${i}`, patterns: [`Bash:tool${i} run`],
        content: `Never run tool ${i} unattended.`, severity: "blocking",
        reason: "there is no undo", ...AGENT_RULE,
      });
    }
    const payload = src.exportDelta(0);
    dst.graftRows({ ...payload, ruleBindings: payload.ruleBindings!.map((b) => ({ ...b, reason: null })) });

    const stats = dst.gateStats("default");
    expect(stats.unexplainedDenies).toHaveLength(7);
    const rendered = renderOverview(dst.overview("default"), { color: false });
    expect(rendered).toContain("gate-0  ·  Never run tool 0 unattended");
    expect(rendered).toContain("gate-6  ·  Never run tool 6 unattended");
    // Every named row is fetchable, not just the first — the id is part of the row shape rather
    // than a decoration on the example.
    for (const ud of stats.unexplainedDenies.slice(0, 5)) {
      expect(rendered, ud.conceptId).toContain(`[${ud.conceptId.slice(0, 8)}] ${ud.stageName}`);
    }

    // AND IT SURVIVES A NARROW TERMINAL. At width 40 the titles are cut to nothing, which is exactly
    // when a trailing id would have been the first thing lost — the case that made placement a
    // correctness question rather than a style one.
    const narrow = renderOverview(dst.overview("default"), { color: false, width: 40 });
    expect(narrow).toContain(`[${stats.unexplainedDenies[0]!.conceptId.slice(0, 8)}]`);
    src.close();
    dst.close();
  });

  it("marks NOTHING when the reason is present, or when a reasonless rule is merely advisory", async () => {
    const c = core();
    // An advisory rule with no reason is the ordinary case, not a broken promise — marking it would
    // bury the one population a caller has to say something about.
    await c.store("Pull before you push.", { kind: "rule", rule: { stage: "git push", instance: "Bash:git push", ...AGENT_RULE } });
    expect(c.gate({ actionContext: "Bash:git push" }).rules[0]).toMatchObject({
      severity: "advisory", reason: null, reasonMissing: false,
    });
    expect(c.gateStats("default").unexplainedDenies).toEqual([]);

    // ...and an ordinary deny, declared properly, is never marked either.
    await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking",
      reason: "there is no undo", ...AGENT_RULE,
    });
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules[0]).toMatchObject({ reasonMissing: false });
    expect(c.gateStats("default").unexplainedDenies).toEqual([]);
    c.close();
  });

  it("REFUSES a relayed binding that claims blocking without a declaration origin", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    const rule = await src.store("An ordinary advisory rule.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    const payload = src.exportDelta(0);
    const forged = { ...payload.ruleBindings![0]!, severity: "blocking" };
    expect(() => dst.graftRows({ ...payload, ruleBindings: [forged] }))
      .toThrow(/blocking is declaration-only and cannot be minted by sync/);
    expect(dst.ruleBinding(rule.conceptId)).toBeNull();
    src.close();
    dst.close();
  });

  it("refuses malformed gate rows and a binding naming a locally source-owned concept", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    await src.store("A rule.", { kind: "rule", rule: { stage: "git force push", ...AGENT_RULE } });
    const payload = src.exportDelta(0);

    expect(() => dst.graftRows({ ...payload, stages: [{ ...payload.stages![0]!, origin: "telepathy" }] }))
      .toThrow(/unknown origin 'telepathy'/);
    expect(() => dst.graftRows({ ...payload, ruleBindings: [{ ...payload.ruleBindings![0]!, scope: "cosmic" }] }))
      .toThrow(/unknown scope 'cosmic'/);
    // scope/model_tag must agree — an untagged compensation is indistinguishable from a domain rule.
    expect(() => dst.graftRows({ ...payload, ruleBindings: [{ ...payload.ruleBindings![0]!, model_tag: null }] }))
      .toThrow(/model tag its scope 'agent' forbids/);
    src.close();
    dst.close();
  });

  it("keeps a graft atomic when two replicas independently created the same stage", async () => {
    const local = core({ syncDeviceId: "machine-a" });
    await local.store("A rule.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    const payload = local.exportDelta(0);
    const mine = local.stages()[0]!.id;
    const theirs = { ...payload.stages![0]!, id: "peer-stage-1" };

    const result = await local.graftRows({ ...payload, stages: [theirs], ruleBindings: [] });
    expect(result.skipped.stages).toBe(1);
    expect(result.inserted.stages).toBe(0);
    expect(local.stages().map((s) => s.id)).toEqual([mine]);
    local.close();
  });

  it("refuses a payload from a protocol version newer than this build understands", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    const payload = src.exportDelta(0);
    expect(() => dst.graftRows({ ...payload, schemaVersion: 16 }))
      .toThrow(/this build understands up to 15/);
    src.close();
    dst.close();
  });
});

// ---------------------------------------------------------------------------
// the safety tier: deny power must be as hard to REMOVE as it is to MINT
// ---------------------------------------------------------------------------
describe("deny power cannot be removed by accident", () => {
  const declareDeny = async (c: MonetCore, content = "Never delete a directory tree unattended.") => {
    const r = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"], content,
      severity: "blocking", reason: "there is no undo", declaredBy: "john", ...AGENT_RULE,
    });
    if (r.species !== "rule") throw new Error("unreachable");
    return r;
  };

  it("PATH 1 — re-declaring without a severity preserves the deny instead of demoting it", async () => {
    const c = resolvingCore();
    const deny = await declareDeny(c);
    expect(c.ruleBinding(deny.conceptId)!.severity).toBe("blocking");

    // The documented onboarding re-sort: the same rule restated, with a reason added and no ruling
    // on severity. Omitted is the ABSENCE of a decision, so the incumbent's decision stands.
    const again = await c.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a directory tree unattended.",
      reason: "there is genuinely no undo", ...AGENT_RULE,
    });
    if (again.species !== "rule") throw new Error("unreachable");
    expect(again.conceptId).toBe(deny.conceptId);
    expect(again.binding.severity).toBe("blocking");
    expect(again.binding.reason).toBe("there is genuinely no undo");
    expect(again.downgraded).toBeUndefined();
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules[0]!.severity).toBe("blocking");
    c.close();
  });

  it("PATH 1 — an EXPLICIT downgrade is allowed, and is reported loudly", async () => {
    const c = resolvingCore();
    const deny = await declareDeny(c);
    const downgraded = await c.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a directory tree unattended.",
      severity: "advisory", ...AGENT_RULE,
    });
    if (downgraded.species !== "rule") throw new Error("unreachable");
    expect(downgraded.conceptId).toBe(deny.conceptId);
    expect(downgraded).toMatchObject({ downgraded: true, from: "blocking" });
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules[0]!.severity).toBe("advisory");

    // Sovereignty runs both ways: the upgrade path is unchanged and reports no downgrade.
    const restored = await c.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a directory tree unattended.",
      severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (restored.species !== "rule") throw new Error("unreachable");
    expect(restored.binding.severity).toBe("blocking");
    expect(restored.downgraded).toBeUndefined();
    c.close();
  });

  /**
   * THE SAME "removed by accident" CLASS, one axis over: BREADTH (Codex round 2, item 1). Re-
   * declaring an existing global ('*') rule without naming a circle used to silently narrow it —
   * declare() could not distinguish "the caller ruled nothing" from "the caller explicitly named
   * the session default", because the MCP handler eagerly resolved an omitted circle to the default
   * BEFORE declare() ever saw it, and declare()'s own `isBreadth ? BREADTH_CIRCLE : undefined`
   * collapsed both cases to the same `undefined`. Fixed at both seams — see RuleCaptureOpts.circle's
   * own three-state contract for the engine-side half, and the memory_declare handler's own comment
   * for the MCP-side half (tested separately, in "MCP surface", since it is a DIFFERENT bug from a
   * DIFFERENT layer).
   */
  it("PATH 1 — breadth — re-declaring a global rule WITHOUT naming a circle preserves it, on the live gate, the mirror, and every circle", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { gateSidecarPath: path });
    const CONTENT = "Never install without a lockfile present.";
    const first = await c.declare({
      circle: "*", species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: CONTENT, severity: "blocking", reason: "an unlocked install can drift", ...AGENT_RULE,
    });
    if (first.species !== "rule") throw new Error("unreachable");
    expect(first.binding.circle).toBe(BREADTH_CIRCLE);

    // Re-declared with IDENTICAL content (dedup resolves onto the SAME concept — the "restatement"
    // shape, same as PATH 1's own severity tests above) and NO circle at all.
    const again = await c.declare({
      species: "rule", stage: "npm install", content: CONTENT,
      severity: "blocking", reason: "an unlocked install can drift", ...AGENT_RULE,
    });
    if (again.species !== "rule") throw new Error("unreachable");
    expect(again.conceptId).toBe(first.conceptId); // proves this really is a restatement, not a new rule
    expect(again.binding.circle).toBe(BREADTH_CIRCLE);
    expect(again.narrowedFromBreadth).toBeUndefined();
    expect(again.previousCircle).toBeUndefined();

    // LIVE GATE: fires from a circle the fixture never otherwise touches — the reach is the
    // marker's, not an accident of overlap with some other circle.
    expect(c.gate({ actionContext: "Bash:npm install", circle: "a-circle-nothing-else-touches" }).rules.map((r) => r.conceptId))
      .toEqual([first.conceptId]);
    // THE MIRROR: materialized fresh, still carries '*' verbatim.
    const mirror = c.materializeGateMirror(path).sidecar;
    expect(mirror.entries.find((e) => e.conceptId === first.conceptId)?.circle).toBe(BREADTH_CIRCLE);
    c.close();
  });

  it("PATH 1 — breadth — an EXPLICIT local circle narrows a global incumbent, and is reported loudly", async () => {
    const c = new MonetCore(":memory:", {});
    const CONTENT = "Never install without a lockfile present.";
    const first = await c.declare({
      circle: "*", species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: CONTENT, severity: "blocking", reason: "an unlocked install can drift", ...AGENT_RULE,
    });
    if (first.species !== "rule") throw new Error("unreachable");

    const narrowed = await c.declare({
      circle: "default", species: "rule", stage: "npm install", content: CONTENT,
      severity: "blocking", reason: "an unlocked install can drift", ...AGENT_RULE,
    });
    if (narrowed.species !== "rule") throw new Error("unreachable");
    expect(narrowed.conceptId).toBe(first.conceptId);
    expect(narrowed.binding.circle).toBe("default");
    // THE DISCLOSURE — legal (the owner's recorded act), never silent.
    expect(narrowed).toMatchObject({ narrowedFromBreadth: true, previousCircle: BREADTH_CIRCLE });
    expect(c.gate({ actionContext: "Bash:npm install", circle: "some-other-circle" }).rules).toEqual([]);
    expect(c.gate({ actionContext: "Bash:npm install", circle: "default" }).rules.map((r) => r.conceptId))
      .toEqual([first.conceptId]);

    // Sovereignty runs both ways here too: re-widening is unchanged and reports no narrowing.
    const restored = await c.declare({
      circle: "*", species: "rule", stage: "npm install", content: CONTENT,
      severity: "blocking", reason: "an unlocked install can drift", ...AGENT_RULE,
    });
    if (restored.species !== "rule") throw new Error("unreachable");
    expect(restored.binding.circle).toBe(BREADTH_CIRCLE);
    expect(restored.narrowedFromBreadth).toBeUndefined();
    c.close();
  });

  it("a NEW declaration without a circle still defaults to defaultCircle, unchanged (Codex round 2, item 1 regression check)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, defaultCircle: "my-default" });
    const rule = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (rule.species !== "rule") throw new Error("unreachable");
    expect(rule.binding.circle).toBe("my-default");
    expect(rule.narrowedFromBreadth).toBeUndefined();
    c.close();
  });

  it("PATH 2 — re-authoring a stage that carries a deny is REFUSED until the denies are named", async () => {
    const c = core();
    const deny = await declareDeny(c);
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules).toHaveLength(1);

    // D0-D2: one ordinary agent-callable declaration used to reroute the deny's firing surface —
    // deny fires, pattern edit, silence, and the binding still reads `blocking`.
    await expect(
      c.declare({ species: "stage", stage: "rm -rf", patterns: ["Bash:something-else"] }),
    ).rejects.toThrow(new RegExp(`would change what 1 blocking rule\\(s\\) deny.*${deny.conceptId}`, "s"));
    // Refused means UNCHANGED: the deny still fires on the action it was declared for.
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules).toHaveLength(1);

    // Acknowledged: the human has seen the deny and is re-aiming it deliberately.
    const reaimed = await c.declare({
      species: "stage", stage: "rm -rf", patterns: ["Bash:rm -rf", "Bash:rm -fr"],
      acknowledgeBlockingRules: [deny.conceptId],
    });
    if (reaimed.species !== "stage") throw new Error("unreachable");
    expect(reaimed.previousPatterns).toEqual(["bash: rm -rf"]);
    expect(reaimed.patterns).toEqual(["bash: rm -rf", "bash: rm -fr"]);
    expect(c.gate({ actionContext: "Bash:rm -fr /tmp/x" }).rules).toHaveLength(1);
    c.close();
  });

  it("PATH 2 — the acknowledgement is enforced INSIDE the write transaction, not just at the edge", async () => {
    const c = resolvingCore();
    const declared = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (declared.species !== "rule") throw new Error("unreachable");

    // THE TOCTOU. declare() validates BEFORE the embed and outside the write transaction, so a deny
    // bound during the embed window would be re-aimed by a call that was validated when no deny
    // existed. Asserting against the layer that performs the mutation is the direct test of where
    // the guard lives: if it existed only in declare(), this would silently re-aim the deny.
    const deps = { db: raw(c) as never, newId: () => "unused", nextSyncTimestamp: () => Date.now(), syncDeviceId: "d" };
    expect(() => upsertStage(deps, { stage: "rm -rf", patterns: ["Bash:something-else"], origin: "declaration" }))
      .toThrow(new RegExp(`would change what 1 blocking rule\\(s\\) deny.*${declared.conceptId}`, "s"));
    // The deny still points where it was declared to point.
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules).toHaveLength(1);

    // Acknowledged at the mutation layer succeeds, which proves both checks read one predicate.
    expect(() => upsertStage(deps, {
      stage: "rm -rf", patterns: ["Bash:something-else"],
      acknowledgeBlockingRules: [declared.conceptId], origin: "declaration",
    })).not.toThrow();
    c.close();
  });

  it("PATH 2 — an empty patterns array disarms a stage, and is guarded like any other replacement", async () => {
    const c = core();
    const deny = await declareDeny(c);
    // `patterns: []` used to coerce to null and be silently ignored — so the one input shape most
    // obviously aimed at disarming a gate slipped past the guard entirely.
    await expect(c.declare({ species: "stage", stage: "rm -rf", patterns: [] }))
      .rejects.toThrow(/would change what 1 blocking rule/);
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules).toHaveLength(1);

    const disarmed = await c.declare({
      species: "stage", stage: "rm -rf", patterns: [], acknowledgeBlockingRules: [deny.conceptId],
    });
    if (disarmed.species !== "stage") throw new Error("unreachable");
    expect(disarmed.patterns).toEqual([]);
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).silence).toBe(true);
    // An inert stage is visible in curation rather than quietly gone.
    expect(c.gateStats().unverifiedPatterns.map((u) => u.stageName)).toContain("rm -rf");
    c.close();
  });

  it("PATH 2 — replacing patterns resets verified, so the watchlist stops vouching for them", async () => {
    const c = core();
    await c.declare({ species: "stage", stage: "terraform apply", patterns: ["terraform apply"] });
    c.gate({ actionContext: "Bash:terraform apply -auto-approve" });
    expect(c.stages()[0]!.verified).toBe(true);

    await c.declare({ species: "stage", stage: "terraform apply", patterns: ["terraform destroy"] });
    // The proof belonged to the OLD patterns. Carrying it across would have the dead-pattern
    // watchlist vouch for a replacement nothing has ever matched.
    expect(c.stages()[0]!.verified).toBe(false);
    expect(c.gateStats().unverifiedPatterns.map((u) => u.patterns)).toEqual([["*: terraform destroy"]]);
    c.close();
  });

  it("PATH 2 — an advisory-only stage is re-authored freely", async () => {
    const c = core();
    await c.declare({ species: "rule", stage: "terraform apply", patterns: ["terraform apply"], content: "Plan first.", ...AGENT_RULE });
    const r = await c.declare({ species: "stage", stage: "terraform apply", patterns: ["terraform destroy"] });
    if (r.species !== "stage") throw new Error("unreachable");
    expect(r.patterns).toEqual(["*: terraform destroy"]);
    c.close();
  });

  it("PATH 4 — sync can neither mint a deny nor demote or repoint one", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    const deny = await declareDeny(src);
    await src.declare({ species: "stage", stage: "another gate", patterns: ["Bash:other"] });
    dst.graftRows(src.exportDelta(0));
    expect(dst.ruleBinding(deny.conceptId)!.severity).toBe("blocking");

    const payload = dst.exportDelta(0);
    const incumbent = payload.ruleBindings!.find((b) => b.concept_id === deny.conceptId)!;
    const bump = (row: typeof incumbent): typeof incumbent =>
      ({ ...row, sync_revision: (row.sync_revision ?? 0) + 5, sync_writer: "zzz-newer-writer" });

    // I1 — DEMOTION by relay. A newer advisory row must not win the contest against a deny.
    const demote = dst.graftRows({ ...payload, ruleBindings: [bump({ ...incumbent, severity: "advisory" })] });
    expect(demote.skipped.rule_bindings).toBe(1);
    expect(dst.ruleBinding(deny.conceptId)!.severity).toBe("blocking");

    // I2 — REPOINTING by relay. Same deny, different stage = a deny on a different action.
    const otherStage = dst.stages().find((s) => s.name === "another gate")!.id;
    const repoint = dst.graftRows({ ...payload, ruleBindings: [bump({ ...incumbent, stage_id: otherStage })] });
    expect(repoint.skipped.rule_bindings).toBe(1);
    expect(dst.ruleBinding(deny.conceptId)!.stage_id).toBe(incumbent.stage_id);

    // I3 — MINTING by relay is refused at preflight, not merely skipped: a payload claiming deny
    // power it cannot have is malformed, not a losing candidate.
    const advisory = await src.store("An ordinary advisory rule.", {
      kind: "rule", rule: { stage: "rm -rf", ...AGENT_RULE },
    });
    const p2 = src.exportDelta(0);
    const forged = { ...p2.ruleBindings!.find((b) => b.concept_id === advisory.conceptId)!, severity: "blocking" };
    expect(() => dst.graftRows({ ...p2, ruleBindings: [forged] }))
      .toThrow(/blocking is declaration-only and cannot be minted by sync/);

    // A peer RESTATING the same deny at the same stage still converges — that is a real agreement.
    const restate = dst.graftRows({ ...payload, ruleBindings: [bump({ ...incumbent, reason: "restated by the peer" })] });
    expect(restate.inserted.rule_bindings).toBe(1);
    expect(dst.ruleBinding(deny.conceptId)).toMatchObject({ severity: "blocking", reason: "restated by the peer" });
    src.close();
    dst.close();
  });

  it("PATH 5 — flagging a rule as contradicted is refused; it was a deny-removal path", async () => {
    const c = core();
    const deny = await declareDeny(c);
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules).toHaveLength(1);

    // flagContradiction sets status='disputed', and the gate delivers only ACTIVE concepts — so the
    // standard MCP tool removed a deny with no declaration anywhere in sight.
    expect(() => c.flagContradiction(deny.conceptId, { detail: "I disagree" }))
      .toThrow(/'dispute \(contradiction\)' would remove the blocking rule/);
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules).toHaveLength(1);
    expect((await c.getConcept(deny.conceptId))!.status).toBe("active");

    // UNIFORM across severities: the refusal is about what a rule IS, not about how hard it bites.
    const advisory = await c.store("An advisory rule.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force", ...AGENT_RULE },
    });
    expect(() => c.flagContradiction(advisory.conceptId, { detail: "hmm" }))
      .toThrow(/is a rule and cannot be flagged as contradicted/);
    // An ordinary concept still flags exactly as before.
    const fact = await c.store("An ordinary fact.", { kind: "fact" });
    expect(c.flagContradiction(fact.conceptId, { detail: "conflicting" }).status).toBe("open");
    c.close();
  });

  it("PATH 6 — an innocent circle move never merges a rule away", async () => {
    const c = resolvingCore();
    // A fact the rule paraphrases, already living in the destination circle. The merge candidate
    // scan is kind-blind, so this is what used to consume the rule and strand its binding.
    await c.store("Never delete a directory tree unattended.", { circle: "target", kind: "fact" });
    const deny = await c.declare({
      circle: "origin", species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a directory tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: "origin" }).rules).toHaveLength(1);

    const moved = c.reassignCircle(deny.conceptId, "target")!;
    // MOVED, not merged: the concept survives with its identity and its binding.
    expect(moved.action).toBe("moved");
    expect(moved.conceptId).toBe(deny.conceptId);
    expect(c.ruleBinding(deny.conceptId)!.severity).toBe("blocking");
    // ...and the deny follows it into the new circle.
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: "target" }).rules).toHaveLength(1);
    // The near-match is not discarded — it reaches curation as a pair, the forceNew-shaped answer.
    expect(c.overview("target").possibleDuplicates.length).toBeGreaterThan(0);
    c.close();
  });

  it("refuses a correction on a blocking rule the caller NAMED, and forks one it merely nominated", async () => {
    const c = resolvingCore();
    const deny = await declareDeny(c, "Never delete a directory tree unattended.");

    // Named: a refusal is correct feedback — the caller asked for a specific thing that cannot be done.
    await expect(c.store("Actually it's fine sometimes.", { kind: "correction", attachTo: deny.conceptId }))
      .rejects.toThrow(/blocking rule and cannot be corrected/);

    // Nominated: resolution chose this concept, not the caller. Throwing here DISCARDED the agent's
    // observation over a property of a concept it never mentioned. It forks and pairs instead.
    const nominated = await c.store("Never delete a directory tree unattended.", { kind: "correction" });
    expect(nominated.conceptId).not.toBe(deny.conceptId);
    expect(nominated.ruleSuccession).toBeUndefined();
    expect(nominated.nearMatchId).toBe(deny.conceptId);
    expect(c.ruleBinding(deny.conceptId)!.severity).toBe("blocking");
    expect(c.overview("default").possibleDuplicates.map((p) => [p.conceptAId, p.conceptBId].sort()))
      .toContainEqual([deny.conceptId, nominated.conceptId].sort());
    c.close();
  });

  it("refuses a correction on a SUPERSEDED rule the caller named, pointing at the successor", async () => {
    const c = resolvingCore();
    const original = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    const successor = await c.store("Force-push is fine on your own branch; never on a shared one.", {
      kind: "correction", attachTo: original.conceptId,
    });
    await expect(c.store("A further correction, aimed at history.", { kind: "correction", attachTo: original.conceptId }))
      .rejects.toThrow(new RegExp(`already been superseded by '${successor.conceptId}'`));
    c.close();
  });
});

describe("the robustness tail", () => {
  const read = (path: string): GateMirror => JSON.parse(readFileSync(path, "utf8")) as GateMirror;

  it("returns its verdict even when the instrumentation write cannot land", async () => {
    const c = core();
    await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    // Break the write half only. A gate lookup that THREW because an event row could not be
    // inserted would be the worst possible trade: an instrumentation row is a rounding error on a
    // rate, a missed delivery is the thing the subsystem exists to prevent.
    const db = raw(c) as unknown as { prepare: (sql: string) => unknown };
    const original = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (sql.includes("INSERT INTO gate_events")) throw new Error("database is locked");
      return original(sql) as never;
    };
    const fired = c.gate({ actionContext: "Bash:git push --force origin main" });
    expect(fired.rules).toHaveLength(1);
    db.prepare = original as never;
    // The verdict survived; only the log did not.
    expect(raw(c).prepare(`SELECT COUNT(*) AS n FROM gate_events`).get()).toEqual({ n: 0 });
    expect(c.gate({ actionContext: "Bash:git push --force origin main" }).rules).toHaveLength(1);
    c.close();
  });

  it("OVERWRITES a sidecar whose generation is ahead of what we are writing, same-store or foreign", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, syncDeviceId: "machine-a" });
    await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    const current = read(path);

    // rename() is atomic, but atomic is not ordered — that motivates COMPARING before replacing, not
    // preserving whatever is already there. Multi-process is the shipped topology (WAL + busy_timeout,
    // set in storage.ts's own constructor precisely so the MCP server and a `monet` CLI call can share
    // one `.monet` DB), so a racing newer writer publishing between another call's snapshot and its
    // rename is real, not theoretical — see materializeGateMirror's own comment and the dedicated
    // race test in "the sidecar generation contract" below, which pins THAT half. HERE, nothing else
    // is mutating: the fabricated file is ahead of the store's CURRENT generation too, with no
    // legitimate writer behind it, so it is debris of an abandoned lineage (a restore or a rollback) —
    // the same event class as the foreign case below — and it is overwritten.
    const newer = { ...current, generation: current.generation + 5, entries: [] };
    writeFileSync(path, JSON.stringify(newer), "utf8");
    const result = c.materializeGateMirror(path);
    expect(result.outcome).toBe("written");
    expect(read(path).generation).toBe(current.generation); // the store's own count, not the fabricated one
    expect(read(path).entries).toHaveLength(1);              // the store's real deny, not the fabricated empty set
    expect(readdirSync(dir)).toEqual(["gate-sidecar.json"]);  // and no temp file left behind

    // A file from ANOTHER store is not ours to defer to either, however high its number — identity
    // already gated the preservation rule before generation did, and still does.
    writeFileSync(path, JSON.stringify({ ...newer, storeIdentity: "machine-b" }), "utf8");
    c.materializeGateMirror(path);
    expect(read(path).storeIdentity).toBe("machine-a");
    expect(read(path).entries).toHaveLength(1);
    c.close();
  });

  /**
   * FILE PERMISSIONS (Codex round 7, item 5, corrected by round 8, item 1; gate-boundary-statement.md,
   * "Binding consequences for 4b", item 1) — reusing source-materializer's own precedent MECHANISM:
   * mode supplied at creation time, never chmod-after. 0600 on the FILE defends against other local
   * accounts and backup tooling reading the mirror's content — never against the agent itself (same
   * uid) — the boundary doc's own framing, unchanged here. Three orthogonal cases, matching
   * materializeGateMirror's own comment: a freshly-created directory (0700, since this call is the
   * one minting it), a pre-existing directory (left exactly as it is — round 7 tightened it, which
   * overreached on a caller-supplied, possibly-shared path; round 8 corrected that), and a
   * pre-existing too-loose FILE (inherits the tight mode via rename regardless, no separate chmod
   * call — this is the actual confidentiality boundary, not the directory).
   */
  it("writes the mirror file at 0600 and its directory at 0700, freshly created (Codex round 7, item 5)", async () => {
    const dir = join(mkTmp(), "fresh-nested"); // does not exist yet: exercises mkdirSync's OWN mode
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    expect(read(path).entries).toHaveLength(1); // the hardening did not break the substantive write
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    c.close();
  });

  it("leaves a pre-existing mirror directory's permissions untouched — the file's own 0600 is the confidentiality boundary, not the directory (Codex round 8, item 1)", async () => {
    if (process.platform === "win32") return; // chmod bits are not meaningful on this platform
    const dir = join(mkTmp(), "already-there");
    mkdirSync(dir, { mode: 0o755 }); // simulates an ordinary, caller-owned directory predating this fix
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    // UNTOUCHED, not tightened — round 7 chmod'd this to 0700, which overreached: `gateSidecarPath`
    // is caller-supplied and `dir` may be `$HOME`, a project directory, or any other shared location
    // the caller populated with unrelated content, none of it this module's to seize. See
    // materializeGateMirror's own comment for why leaving it alone does not reopen the confidentiality
    // gap the fix exists to close — the FILE's own 0600, asserted below, is the actual boundary.
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(read(path).entries).toHaveLength(1);
    c.close();
  });

  it("a rename onto a pre-existing looser-permissioned mirror file tightens it to 0600 too, with no separate chmod (Codex round 7, item 5)", async () => {
    if (process.platform === "win32") return;
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    writeFileSync(path, JSON.stringify({ format: GATE_MIRROR_FORMAT, generation: 0, entries: [] }), { mode: 0o644 });
    expect(statSync(path).mode & 0o777).toBe(0o644);
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    // Inherited from the freshly-written 0600 tmp file via rename — see the "TARGET INHERITS 0600
    // VIA RENAME" comment at materializeGateMirror's own renameSync call.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(read(path).entries).toHaveLength(1);
    c.close();
  });

  /**
   * EXCLUSIVE, UNPREDICTABLE TMP CREATION (Codex round 9, item 1, P1) — the composition hole round
   * 7 + round 8 opened between them: round 7 rejected `O_EXCL` reasoning the (then-tightened) 0700
   * directory already closed the preplant window; round 8 correctly removed that tightening on its
   * own separate terms; neither round was wrong alone, but together the tmp write was left with no
   * exclusivity of its own AND no directory protection. `Date.now()` and `crypto.randomUUID()` are
   * both pinned so the exact tmp path materializeGateMirror will attempt is known in advance —
   * otherwise a test cannot pre-plant at the right path at all, which is itself part of what makes a
   * REAL random suffix safe (an attacker cannot do what this test setup does).
   */
  it("refuses to write the mirror through a pre-planted regular file at the tmp path — its content survives untouched, and materialize throws named (Codex round 9, item 1)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    // DECLARE FIRST, mock SECOND — `store()`/`declare()` mint their own concept/binding ids via this
    // SAME `randomUUID` (engine.ts's `this.newId`), so this runs with the REAL implementation still
    // in effect, before the module-level mock's `mockReturnValueOnce` is ever armed.
    await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });

    const fixedNow = 1732000000000;
    const fixedUuid = "11111111-1111-1111-1111-111111111111";
    // PERSISTENT for Date.now (materializeGateMirror calls it twice — once for `generatedAt`, once
    // for the tmp suffix — both need the SAME value), explicitly restored below. ONCE ONLY for
    // randomUUID — see the module-level `vi.mock` comment for why anything more persistent here
    // would be file-wide unsafe.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    try {
      vi.mocked(nodeCrypto.randomUUID).mockReturnValueOnce(fixedUuid as `${string}-${string}-${string}-${string}-${string}`);
      const plantedTmp = join(dir, `.${basename(path)}.${process.pid}.${fixedNow}.${fixedUuid}.tmp`);
      const plantedContent = "NOT A GATE MIRROR — planted ahead of the exclusive-create attempt";
      writeFileSync(plantedTmp, plantedContent, "utf8");

      // materializeGateMirror() DIRECTLY, not through declare()'s own refreshGateSidecar() — that
      // path wraps materializeGateMirror in a try/catch that deliberately swallows failures (see
      // refreshGateSidecar's own comment, engine.ts), which would hide the very throw this test
      // exists to pin.
      expect(() => c.materializeGateMirror(path)).toThrow(/freshly-randomized path/);
      // THE PLANTED FILE'S CONTENT IS UNCHANGED — the write never went through it. `wx` failing
      // means writeFileSync did not touch the existing inode at all, not merely "reverted" it.
      expect(readFileSync(plantedTmp, "utf8")).toBe(plantedContent);
      // THE REAL TARGET WAS NEVER CREATED EITHER — materialize failed before ever reaching rename.
      expect(existsSync(path)).toBe(false);
    } finally {
      nowSpy.mockRestore();
      c.close();
    }
  });

  it("refuses to write the mirror through a pre-planted symlink at the tmp path — the symlink's victim target survives untouched, and materialize throws named (Codex round 9, item 1)", async () => {
    if (process.platform === "win32") return; // symlink semantics are not this test's concern there
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });

    const fixedNow = 1732000000001;
    const fixedUuid = "22222222-2222-2222-2222-222222222222";
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    try {
      vi.mocked(nodeCrypto.randomUUID).mockReturnValueOnce(fixedUuid as `${string}-${string}-${string}-${string}-${string}`);
      const victim = join(mkTmp(), "victim.txt"); // a DIFFERENT directory — the classic symlink-escape shape
      const victimContent = "the attacker's real target, elsewhere on disk";
      writeFileSync(victim, victimContent, "utf8");
      const plantedTmp = join(dir, `.${basename(path)}.${process.pid}.${fixedNow}.${fixedUuid}.tmp`);
      symlinkSync(victim, plantedTmp);

      expect(() => c.materializeGateMirror(path)).toThrow(/freshly-randomized path/);
      // THE VICTIM FILE — what the symlink actually points at — IS UNCHANGED: `wx` refuses a
      // pre-existing symlink at the leaf path WITHOUT following it (POSIX, cited in the mechanism's
      // own comment), so the write never reaches the far end at all.
      expect(readFileSync(victim, "utf8")).toBe(victimContent);
      expect(existsSync(path)).toBe(false);
    } finally {
      nowSpy.mockRestore();
      c.close();
    }
  });

  it("re-materializes the mirror after a circle move, like every other bump site", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, defaultCircle: "proj" });
    const deny = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    expect(read(path).entries[0]!.circle).toBe("proj");

    c.reassignCircle(deny.conceptId, "elsewhere");
    // Detection already covered this (isSidecarStale would have said so), but a mirror that goes
    // stale on an ordinary move and waits to be asked is not the contract the other sites keep.
    expect(c.isSidecarStale().stale).toBe(false);
    expect(read(path).entries[0]!.circle).toBe("elsewhere");
    c.close();
  });

  it("bounds how many patterns one stage can carry", async () => {
    const c = core();
    const many = Array.from({ length: 33 }, (_, i) => `Bash:tool${i} run`);
    // Every gate lookup scans every pattern of every stage, so an unbounded array is an unbounded
    // per-action cost any declaration could inflict.
    await expect(c.declare({ species: "stage", stage: "too many", patterns: many }))
      .rejects.toThrow(/at most 32 trigger patterns \(got 33\)/);
    await c.declare({ species: "stage", stage: "just enough", patterns: many.slice(0, 32) });
    expect(c.stages()[0]!.patterns).toHaveLength(32);

    // A row that arrived some other way is CLAMPED rather than rejected, and the overflow is
    // counted so it surfaces in curation instead of vanishing.
    const stageId = c.stages()[0]!.id;
    raw(c).prepare(`UPDATE stages SET trigger_patterns = ? WHERE id = ?`).run(
      JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ tool: "bash", tokens: [`tool${i}`, "run"] }))),
      stageId,
    );
    expect(parseTriggerPatterns(
      (raw(c).prepare(`SELECT trigger_patterns AS p FROM stages WHERE id = ?`).get(stageId) as { p: string }).p,
    )).toHaveLength(32);
    expect(c.gateStats().malformedPatterns[0]).toMatchObject({ stageId, malformed: 8 });
    c.close();
  });
});

describe("receipt replay", () => {
  it("returns the SAME rule outcome on a retried operationId", async () => {
    const c = core();
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
      operationId: "op-capture-1",
    });
    expect(rule.ruleBindingChange).toEqual({
      conceptId: rule.conceptId, severity: "advisory", previousSeverity: null, downgradedFromBlocking: false,
      narrowedFromBreadth: false, previousCircle: null, // brand-new binding — no incumbent to have replaced
      circle: "default", // POST-write circle (Codex round 12, item 3) — this store's own implicit default
    });
    // A retry must be indistinguishable from the first call — the whole contract of operationId,
    // and a caller branching on these fields would otherwise act differently on retry.
    const replayed = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", ...AGENT_RULE }, operationId: "op-capture-1",
    });
    expect(replayed.ruleBindingChange).toEqual(rule.ruleBindingChange);
    expect(replayed.conceptId).toBe(rule.conceptId);

    const successor = await c.store("Force-push is fine on your own branch.", {
      kind: "correction", attachTo: rule.conceptId, operationId: "op-correct-1",
    });
    expect(successor.ruleSuccession).toBeDefined();
    const replayedCorrection = await c.store("Force-push is fine on your own branch.", {
      kind: "correction", attachTo: rule.conceptId, operationId: "op-correct-1",
    });
    // Reconstructed from the supersession edge, which records the correction that caused it.
    expect(replayedCorrection.ruleSuccession).toEqual(successor.ruleSuccession);
    // ...and a succession reports no binding change on either call, so replay invents nothing.
    expect(replayedCorrection.ruleBindingChange).toBeUndefined();
    expect(successor.ruleBindingChange).toBeUndefined();
    c.close();
  });

  it("replays a DOWNGRADE faithfully — the one transition the substrate cannot re-derive", async () => {
    const c = resolvingCore();
    await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    const downgrade = await c.store("Never delete a tree unattended.", {
      kind: "rule", operationId: "op-downgrade-1",
      rule: { stage: "rm -rf", severity: "advisory", declaration: true, ...AGENT_RULE },
    });
    expect(downgrade.ruleBindingChange).toMatchObject({ previousSeverity: "blocking", downgradedFromBlocking: true });
    const replayed = await c.store("Never delete a tree unattended.", {
      kind: "rule", operationId: "op-downgrade-1",
      rule: { stage: "rm -rf", severity: "advisory", declaration: true, ...AGENT_RULE },
    });
    expect(replayed.ruleBindingChange).toEqual(downgrade.ruleBindingChange);
    c.close();
  });

  /**
   * REPLAYS A NARROWING FAITHFULLY TOO (Codex round 10, item 4) — the SAME shape as the downgrade
   * replay test just above, for the OTHER transition the substrate cannot re-derive from the current
   * binding alone. Before this fix, `replayRuleOutcome` had no `rule_previous_circle` to read, so a
   * replayed call always reported `narrowedFromBreadth: false` regardless of what the FIRST call
   * said — exactly the under-disclosure the coordinator's own item names.
   */
  it("replays a NARROWING (from breadth) faithfully — the other transition the substrate cannot re-derive", async () => {
    const c = resolvingCore();
    await c.declare({
      circle: BREADTH_CIRCLE, species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    const narrowed = await c.store("Never delete a tree unattended.", {
      circle: "default", kind: "rule", operationId: "op-narrow-1",
      rule: { stage: "rm -rf", circle: "default", declaration: true, severity: "blocking", reason: "there is no undo", ...AGENT_RULE },
    });
    expect(narrowed.ruleBindingChange).toMatchObject({
      previousCircle: BREADTH_CIRCLE, narrowedFromBreadth: true,
    });
    expect(c.ruleBinding(narrowed.conceptId)?.circle).toBe("default");
    const replayed = await c.store("Never delete a tree unattended.", {
      circle: "default", kind: "rule", operationId: "op-narrow-1",
      rule: { stage: "rm -rf", circle: "default", declaration: true, severity: "blocking", reason: "there is no undo", ...AGENT_RULE },
    });
    expect(replayed.ruleBindingChange).toEqual(narrowed.ruleBindingChange);
    c.close();
  });

  /**
   * THE EXACT SCENARIO REVIEW FOUND (Codex round 12, item 3): the test just above proves A's own
   * narrowing replays faithfully in isolation — it never proves A survives a LATER, DIFFERENT act
   * touching the SAME binding. Comparing `previousCircle` against the binding's CURRENT circle (one
   * version of `replayRuleOutcome` ago) was right at the moment A first ran and silently wrong
   * forever after B moved the binding again — this is the test that would have caught it.
   */
  it("replays A's narrowing faithfully even after a LATER operation B widens the SAME rule back to breadth (Codex round 12, item 3)", async () => {
    const c = resolvingCore();
    await c.declare({
      circle: BREADTH_CIRCLE, species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    // OPERATION A: narrows the global rule to 'default'.
    const narrowed = await c.store("Never delete a tree unattended.", {
      circle: "default", kind: "rule", operationId: "op-narrow-then-widen-1",
      rule: { stage: "rm -rf", circle: "default", declaration: true, severity: "blocking", reason: "there is no undo", ...AGENT_RULE },
    });
    expect(narrowed.ruleBindingChange).toMatchObject({ previousCircle: BREADTH_CIRCLE, narrowedFromBreadth: true, circle: "default" });

    // OPERATION B, LATER, a DIFFERENT act (its own fresh operationId — not a retry of A): widens the
    // SAME rule back to '*'. Top-level `circle` stays "default" — the CONCEPT's own home, unchanged
    // this whole time (a concept may never itself live in '*'; only `rule.circle`, the BINDING's own
    // ruling, can be the breadth marker — the same distinction the narrow step above already draws).
    await c.store("Never delete a tree unattended.", {
      circle: "default", kind: "rule", operationId: "op-widen-back-1",
      rule: { stage: "rm -rf", circle: BREADTH_CIRCLE, declaration: true, severity: "blocking", reason: "there is no undo", ...AGENT_RULE },
    });
    // LIVE STATE, confirmed: global again, because of B.
    expect(c.ruleBinding(narrowed.conceptId)!.circle).toBe(BREADTH_CIRCLE);

    // REPLAYING A must still report what A ACTUALLY DID, not what the binding says NOW. Before this
    // fix, `narrowedFromBreadth` compared A's own stored `previousCircle` against the LIVE binding
    // (now '*' again, thanks to B) and silently reported `false` — A's own narrowing, erased.
    const replayedA = await c.store("Never delete a tree unattended.", {
      circle: "default", kind: "rule", operationId: "op-narrow-then-widen-1",
      rule: { stage: "rm -rf", circle: "default", declaration: true, severity: "blocking", reason: "there is no undo", ...AGENT_RULE },
    });
    expect(replayedA.ruleBindingChange).toEqual(narrowed.ruleBindingChange);
    expect(replayedA.ruleBindingChange).toMatchObject({
      narrowedFromBreadth: true, previousCircle: BREADTH_CIRCLE, circle: "default",
    });
    c.close();
  });

  /**
   * THE TWIN BUG, SAME FIX (Codex round 12, item 4 — the final item, flagged while implementing item
   * 3, confirmed in scope, not silently expanded into). `downgradedFromBlocking` shared the exact
   * comparison-against-the-live-binding shape `narrowedFromBreadth` just had — the test just above,
   * one axis over.
   */
  it("replays A's downgrade faithfully even after a LATER operation B re-declares the SAME rule blocking (Codex round 12, item 4)", async () => {
    const c = resolvingCore();
    await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    // OPERATION A: downgrades the rule to advisory.
    const downgrade = await c.store("Never delete a tree unattended.", {
      kind: "rule", operationId: "op-downgrade-then-redeclare-1",
      rule: { stage: "rm -rf", severity: "advisory", declaration: true, ...AGENT_RULE },
    });
    expect(downgrade.ruleBindingChange).toMatchObject({ previousSeverity: "blocking", downgradedFromBlocking: true, severity: "advisory" });

    // OPERATION B, LATER, a DIFFERENT act (its own fresh operationId — not a retry of A): re-declares
    // the SAME rule blocking again.
    await c.store("Never delete a tree unattended.", {
      kind: "rule", operationId: "op-redeclare-blocking-1",
      rule: { stage: "rm -rf", severity: "blocking", declaration: true, reason: "there is no undo", ...AGENT_RULE },
    });
    // LIVE STATE, confirmed: blocking again, because of B.
    expect(c.ruleBinding(downgrade.conceptId)!.severity).toBe("blocking");

    // REPLAYING A must still report what A ACTUALLY DID, not what the binding says NOW. Before this
    // fix, both `downgradedFromBlocking` AND `severity` itself compared/read against the LIVE binding
    // (now blocking again, thanks to B) — `downgradedFromBlocking` would have silently reported
    // `false` (A's own downgrade, erased), and `severity: "blocking"` would have contradicted
    // `previousSeverity: "blocking"` outright, failing "indistinguishable from the first call" for
    // that field alone even if the boolean had been fixed in isolation.
    const replayedA = await c.store("Never delete a tree unattended.", {
      kind: "rule", operationId: "op-downgrade-then-redeclare-1",
      rule: { stage: "rm -rf", severity: "advisory", declaration: true, ...AGENT_RULE },
    });
    expect(replayedA.ruleBindingChange).toEqual(downgrade.ruleBindingChange);
    expect(replayedA.ruleBindingChange).toMatchObject({
      downgradedFromBlocking: true, previousSeverity: "blocking", severity: "advisory",
    });
    c.close();
  });

  it("returns nothing rule-shaped for an ordinary write, on both the fresh path and the replay", async () => {
    const c = core();
    const fact = await c.store("An ordinary fact.", { kind: "fact", operationId: "op-fact-1" });
    expect(fact.ruleBindingChange).toBeUndefined();
    expect(fact.ruleSuccession).toBeUndefined();
    const replayed = await c.store("An ordinary fact.", { kind: "fact", operationId: "op-fact-1" });
    expect(replayed.ruleBindingChange).toBeUndefined();
    expect(replayed.ruleSuccession).toBeUndefined();
    c.close();
  });

  /**
   * THE TWO 5-B OUTCOMES (review fix — Codex 5-B round 1, F3). `extractionCandidate` and
   * `ruleSuccession.impeachedPrincipleIds` are both things a caller ACTS on — flag a pair for the
   * battery, tell the human which principles just left the skeleton — and neither was reconstructed
   * at replay, so a caller that lost the first response and retried was told nothing happened.
   *
   * They cannot co-occur on ONE write by construction (storeInternal branches: a supersession takes
   * the `ruleSuccession` arm, a fresh rule birth the extraction arm), so each gets its own
   * operation here rather than a contrived single one.
   */
  it("replays an EXTRACTION-CANDIDATE flag field-for-field", async () => {
    // The ambiguous band the 5-B flagging block uses: the flag rides a fork's near-match.
    const c = new MonetCore(":memory:", { tauAttach: 0.99, tauAmbiguous: 0.1 });
    const first = await c.store("Verify the built artifact after the source changes.", {
      kind: "rule", rule: { stage: "docker build", instance: "Bash:docker build .", scope: "domain" },
    });
    const second = await c.store("After the source changes, verify the artifact itself.", {
      kind: "rule", rule: { stage: "npm install", instance: "Bash:npm install", scope: "domain" },
      operationId: "op-extraction-1",
    });
    expect(second.extractionCandidate).toEqual({ pairedRuleId: first.conceptId, score: second.nearMatchScore });

    const replayed = await c.store("After the source changes, verify the artifact itself.", {
      kind: "rule", rule: { stage: "npm install", scope: "domain" }, operationId: "op-extraction-1",
    });
    expect(replayed.extractionCandidate).toEqual(second.extractionCandidate);
    expect(replayed.ruleBindingChange).toEqual(second.ruleBindingChange);

    // STILL REPORTED AFTER A HUMAN DISMISSES THE PAIR: the write DID flag it, and "indistinguishable
    // from the first call" is a claim about what this operation produced, not about what is open now.
    c.dismissPossibleDuplicate(first.conceptId, second.conceptId, "john");
    expect(c.overview("default").counts.extractionCandidates).toBe(0);
    const afterDismissal = await c.store("After the source changes, verify the artifact itself.", {
      kind: "rule", rule: { stage: "npm install", scope: "domain" }, operationId: "op-extraction-1",
    });
    expect(afterDismissal.extractionCandidate).toEqual(second.extractionCandidate);
    c.close();
  });

  it("does NOT invent an extraction candidate for a near-match that never flagged one", async () => {
    // Same band, same fork — but both rules sit at ONE stage, so the breadth precondition fails and
    // the fresh call reported nothing. A replay reading `near_match_id` alone would invent one.
    const c = new MonetCore(":memory:", { tauAttach: 0.99, tauAmbiguous: 0.1 });
    await c.store("Verify the built artifact after the source changes.", {
      kind: "rule", rule: { stage: "docker build", instance: "Bash:docker build .", scope: "domain" },
    });
    const second = await c.store("After the source changes, verify the artifact itself.", {
      kind: "rule", rule: { stage: "docker build", scope: "domain" }, operationId: "op-same-stage-1",
    });
    expect(second.nearMatchId).toBeTruthy();
    expect(second.extractionCandidate).toBeUndefined();
    const replayed = await c.store("After the source changes, verify the artifact itself.", {
      kind: "rule", rule: { stage: "docker build", scope: "domain" }, operationId: "op-same-stage-1",
    });
    expect(replayed.extractionCandidate).toBeUndefined();
    c.close();
  });

  it("replays a correction's impeachedPrincipleIds field-for-field", async () => {
    const c = core();
    const declared = await c.declare({ species: "principle", content: "Irreversible acts get a confirmation.", declaredBy: "john" });
    if (declared.species !== "principle") throw new Error("unreachable");
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    c.addLifecycleEdge({ family: "derivation", srcConceptId: declared.conceptId, dstConceptId: rule.conceptId, bornOf: "extraction" });

    const correction = await c.store("Force-push is fine on your own branch; never on a shared one.", {
      kind: "correction", attachTo: rule.conceptId, operationId: "op-impeach-1",
    });
    expect(correction.ruleSuccession!.impeachedPrincipleIds).toEqual([declared.conceptId]);

    const replayed = await c.store("Force-push is fine on your own branch; never on a shared one.", {
      kind: "correction", attachTo: rule.conceptId, operationId: "op-impeach-1",
    });
    expect(replayed.ruleSuccession).toEqual(correction.ruleSuccession);

    // AND AFTER THE HUMAN MEDIATES IT: the impeachment is closed, the principle is active again, and
    // the replay still reports what THIS write did — reconstructed from the contradiction record,
    // never re-derived from live state (which would now answer "nothing").
    const contradictionId = (raw(c).prepare(
      `SELECT id FROM contradictions WHERE concept_id = ? AND kind = 'impeachment'`,
    ).get(declared.conceptId) as { id: string }).id;
    c.resolveContradiction(contradictionId, { decision: "dismiss", by: "john" });
    expect((await c.getConcept(declared.conceptId))!.status).toBe("active");
    const afterMediation = await c.store("Force-push is fine on your own branch; never on a shared one.", {
      kind: "correction", attachTo: rule.conceptId, operationId: "op-impeach-1",
    });
    expect(afterMediation.ruleSuccession).toEqual(correction.ruleSuccession);
    c.close();
  });

  it("omits impeachedPrincipleIds on replay when the correction impeached nothing", async () => {
    const c = core();
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    const correction = await c.store("Force-push is fine on your own branch; never on a shared one.", {
      kind: "correction", attachTo: rule.conceptId, operationId: "op-no-impeach-1",
    });
    expect(correction.ruleSuccession!.impeachedPrincipleIds).toBeUndefined();
    const replayed = await c.store("Force-push is fine on your own branch; never on a shared one.", {
      kind: "correction", attachTo: rule.conceptId, operationId: "op-no-impeach-1",
    });
    expect(replayed.ruleSuccession).toEqual(correction.ruleSuccession);
    expect(replayed.ruleSuccession!.impeachedPrincipleIds).toBeUndefined();
    c.close();
  });
});

describe("the chokepoint: every door is a call site", () => {
  /**
   * THE EXHAUSTIVE BATTERY. Eight deny-removal doors were found one at a time across three review
   * rounds; this iterates every guarded operation against one live deny and asserts the deny still
   * fires after each attempt. A ninth door added without the guard fails here the moment somebody
   * adds it to this list — and one added without being added to this list is exactly the failure
   * the guard's own doc comment names.
   */
  async function liveDeny(c: MonetCore) {
    const r = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a directory tree unattended.", severity: "blocking",
      reason: "there is no undo", declaredBy: "john", ...AGENT_RULE,
    });
    if (r.species !== "rule") throw new Error("unreachable");
    return r;
  }
  const fires = (c: MonetCore, circle?: string): number =>
    c.gate({ actionContext: "Bash:rm -rf /tmp/x", circle }).rules.filter((rule) => rule.severity === "blocking").length;

  it("refuses every LOCAL operation that would remove a live deny, and the deny survives each", async () => {
    const c = resolvingCore();
    const deny = await liveDeny(c);
    const other = await c.store("An unrelated concept in this circle.", { kind: "fact" });
    expect(fires(c)).toBe(1);

    const attempts: Array<[string, () => unknown | Promise<unknown>]> = [
      ["retire", () => c.retireConcept(deny.conceptId)],
      ["dispute (contradiction)", () => c.flagContradiction(deny.conceptId, { detail: "I disagree" })],
      ["consolidating detach", async () => {
        const full = await c.getConcept(deny.conceptId);
        return c.detach(deny.conceptId, full!.observations.map((o) => o.id), { destConceptId: other.conceptId });
      }],
      ["merge via circle move", async () => {
        // Auto-merge is already refused structurally for rules; assert the deny survives the move.
        c.reassignCircle(deny.conceptId, "elsewhere");
        return null;
      }],
    ];
    attempts.push(["circle move into an archived circle", () => {
      // ISSUE #184. A move to a LIVE circle is the one legitimate deny relocation (asserted at the
      // end of this test); a move into a circle the store has flagged archived is a removal wearing
      // a relocation's clothes, so it belongs in the battery like every other door.
      c.archiveCircle("the-attic");
      return c.reassignCircle(deny.conceptId, "the-attic");
    }]);
    attempts.push(["supersession (public API)", () => {
      // DOOR 11. The exported slice-3 API predates the guard, and the inventory that found the
      // other doors grepped status writes and concept deletes — which structurally could not see
      // this one, because superseding removes a rule from the gate without touching either.
      const successor = c.stages(); void successor;
      return c.addLifecycleEdge({
        family: "supersession", srcConceptId: deny.conceptId, dstConceptId: other.conceptId, bornOf: "declaration",
      });
    }]);

    for (const [name, run] of attempts) {
      if (name === "merge via circle move") continue; // asserted below — it SUCCEEDS as a move
      await expect(Promise.resolve().then(run), `${name} must be refused`).rejects.toThrow(/blocking rule/);
      expect(fires(c), `${name} left the deny changed`).toBe(1);
    }

    // The move is legitimate and the deny follows the rule into its new circle.
    c.reassignCircle(deny.conceptId, "elsewhere");
    expect(fires(c, "elsewhere")).toBe(1);
    expect(c.ruleBinding(deny.conceptId)!.severity).toBe("blocking");
    c.close();
  });

  /**
   * ISSUE #184 — THE DOOR ARCHIVING OPENED, on its own, with the origin circle's gate asserted after
   * the refusal. `RULE_LIVENESS_WHERE` matches on the querying session's circle and never reads
   * `circle_aliases.status`, so archiving is delivery-inert and a move into an archived circle is
   * the whole of the removal: the deny leaves the circle people work in and lands where, by the
   * store's own flag, nobody queries. The legitimate route is unchanged — withdraw by declaration,
   * then move — so this refusal costs a caller who genuinely means it exactly one honest step.
   */
  it("refuses a circle move into an ARCHIVED circle, and the deny still fires where it already was", async () => {
    const c = resolvingCore();
    const deny = await liveDeny(c);
    c.archiveCircle("the-attic");
    expect(fires(c)).toBe(1);

    expect(() => c.reassignCircle(deny.conceptId, "the-attic")).toThrow(/blocking rule/);
    // The deny did not move and did not stop governing the circle it was declared in.
    expect(c.circleOf(deny.conceptId)).toBe("default");
    expect(fires(c)).toBe(1);
    expect(c.ruleBinding(deny.conceptId)!.severity).toBe("blocking");

    // AND THE DECLARED WITHDRAWAL STILL OPENS IT — the guard refuses the silent route, not the act.
    await withdrawDeny(c, deny.conceptId, "rm -rf");
    expect(fires(c)).toBe(0);
    expect(c.reassignCircle(deny.conceptId, "the-attic")!.action).toBe("moved");
    expect(c.circleOf(deny.conceptId)).toBe("the-attic");
    c.close();
  });

  /**
   * THE DOOR IS INHERITED, NOT RE-IMPLEMENTED. batchReassignCircle loops reassignCircle per concept,
   * so it is closed by construction rather than by a second call site — which is the shape the
   * chokepoint's doc comment asks for. That is only true while it keeps delegating: a refactor that
   * inlines the loop reopens it while every assertion above still passes, because those exercise the
   * single-concept path only. Hence this test. A batch is per-item, so the deny's item errors and
   * its batch-mates still move.
   *
   * MERGECIRCLE IS THE EXEMPTION, and this is where it is pinned (issue #184, review round 3). It
   * delegates too, but through the internal method with `sourceNameResolvesToDestination` set,
   * because it publishes an ACTIVE from→into alias in the SAME transaction as its moves. Refusing it
   * removed nothing and cost everything: one refused item rolled an entire merge back, and the
   * refusal's own remediation is "declare it advisory" — a caller following it would trade a real
   * deny away to get past a guard that was protecting nothing. The property the exemption is named
   * for is asserted below: after the merge the deny still fires under the SOURCE circle's name.
   */
  it("the archived-circle door stays shut through batchReassignCircle, and mergeCircle passes because its alias keeps the source name firing", async () => {
    const c = resolvingCore();
    const deny = await liveDeny(c);
    const fact = await c.store("An ordinary concept riding the same batch.", { kind: "fact" });
    c.archiveCircle("the-attic");
    expect(fires(c)).toBe(1);

    const batch = c.batchReassignCircle([deny.conceptId, fact.conceptId], "the-attic");
    expect(batch.counts).toMatchObject({ moved: 1, error: 1 });
    const denyItem = batch.results.find((r) => r.action === "error" && r.id === deny.conceptId);
    expect(denyItem, "the deny's own item must carry the refusal").toBeDefined();
    expect((denyItem as { error: string }).error).toMatch(/blocking rule/);
    // The refusal is scoped to the deny: its batch-mate still moved, and the deny still governs.
    expect(c.circleOf(fact.conceptId)).toBe("the-attic");
    expect(c.circleOf(deny.conceptId)).toBe("default");
    expect(fires(c)).toBe(1);

    // A move to a LIVE circle is the legal relocation, so the deny can be staged for the merge.
    c.reassignCircle(deny.conceptId, "staging");
    expect(fires(c, "staging")).toBe(1);

    // ...AND THE MERGE OF THAT SAME CIRCLE INTO THAT SAME ARCHIVED ONE SUCCEEDS, because it repoints
    // the source name at the destination instead of stranding it.
    const merged = await c.mergeCircle("staging", "the-attic");
    expect(merged.counts).toMatchObject({ moved: 1, error: 0 });
    expect(c.circleOf(deny.conceptId)).toBe("the-attic");
    expect(c.ruleBinding(deny.conceptId)!.severity).toBe("blocking");
    // THE WHOLE PREMISE OF THE EXEMPTION, measured: the alias mergeCircle published redirects the
    // source name, so the deny fires under it exactly as before — and in the destination. Coverage
    // is identical before and after, which is why there was nothing for the door to protect.
    expect(fires(c, "staging")).toBe(1);
    expect(fires(c, "the-attic")).toBe(1);
    c.close();
  });

  /**
   * THE OTHER HALF OF THAT PREMISE (review round 2). The refusal above is right because the move
   * takes the deny away from where people work — and that is a claim about the BINDING, not about
   * the concept's destination. A breadth ('*') binding never follows its concept (moveConcept
   * excludes it deliberately, see its own comment), so this move removes nothing at all: the deny
   * keeps firing in the circle it left and in every other one.
   *
   * Refusing it would therefore be worse than a guard on a no-op. The chokepoint's remediation is
   * "withdraw the deny by declaring it advisory", so a caller who followed the error message would
   * trade a REAL deny away to get past a refusal that was protecting nothing — the exact harm the
   * guard exists to prevent, produced by the guard.
   */
  it("MOVES a BREADTH-bound live deny into an archived circle — that move takes delivery from nowhere", async () => {
    const c = resolvingCore();
    const declared = await c.declare({
      circle: BREADTH_CIRCLE, species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a directory tree unattended.", severity: "blocking",
      reason: "there is no undo", declaredBy: "john", ...AGENT_RULE,
    });
    if (declared.species !== "rule") throw new Error("unreachable");
    // The concept lives at the ordinary default circle; only the BINDING is global.
    expect(c.ruleBinding(declared.conceptId)!.circle).toBe(BREADTH_CIRCLE);
    expect(c.circleOf(declared.conceptId)).toBe("default");
    c.archiveCircle("the-attic");
    expect(fires(c)).toBe(1);

    expect(c.reassignCircle(declared.conceptId, "the-attic")!.action).toBe("moved");
    expect(c.circleOf(declared.conceptId)).toBe("the-attic");
    // THE BINDING DID NOT MOVE, which is the whole reason the move was allowed.
    expect(c.ruleBinding(declared.conceptId)).toMatchObject({ circle: BREADTH_CIRCLE, severity: "blocking" });
    // And delivery is exactly what it was: the origin circle, the archived destination, and a
    // circle nothing in this fixture has ever touched.
    expect(fires(c)).toBe(1);
    expect(fires(c, "the-attic")).toBe(1);
    expect(fires(c, "a-circle-nothing-else-touches")).toBe(1);
    c.close();
  });

  /**
   * THE GUARD IS RE-ASSERTED UNDER THE WRITE RESERVATION, proved against a REAL second connection
   * rather than by inspecting the code shape. reassignCircle's fast-fail copy runs some forty lines
   * and a full `bestMatches` vector scan before `BEGIN IMMEDIATE`, and one `.monet` file shared by
   * the MCP server and a `monet` CLI call is a supported topology (storage.ts's WAL + busy_timeout
   * setup exists for precisely that) — so "the destination was live when we checked" is a fact with
   * a shelf life.
   *
   * The window is opened deliberately rather than approximated, the same discipline `raceOnEmbed`
   * uses earlier in this file: the second connection commits its `archiveCircle` from inside
   * `bestMatches`, which is the work that actually sits in the gap. Without the inner copy the move
   * commits and the deny lands in an archived circle, silently stopping for the circle it left.
   */
  it("re-checks the archived destination INSIDE the write reservation, against a second connection archiving mid-move", async () => {
    const dbPath = join(mkTmp(), "race.db");
    const a = new MonetCore(dbPath);
    const b = new MonetCore(dbPath); // the competing writer: its own connection to the same file
    const deny = await liveDeny(a);
    expect(fires(a)).toBe(1);
    // Not archived yet, so the fast-fail copy passes — which is the premise of the whole test.
    expect(a.reassignCircle(deny.conceptId, "still-live")!.action).toBe("moved");
    expect(fires(a, "still-live")).toBe(1);

    type Matcher = { bestMatches(emb: Float32Array, circle: string, m: number): unknown[] };
    const original = (Object.getPrototypeOf(a) as Matcher).bestMatches;
    let raced = false;
    const spy = vi.spyOn(a as unknown as Matcher, "bestMatches").mockImplementation((emb, circle, m) => {
      if (!raced) {
        raced = true;
        b.archiveCircle("the-attic"); // a real commit, on a real second connection, mid-window
      }
      return original.call(a as unknown as Matcher, emb, circle, m);
    });

    expect(() => a.reassignCircle(deny.conceptId, "the-attic")).toThrow(/blocking rule/);
    // The refusal came from the INNER copy, necessarily: the outer one ran before the archive
    // existed, and had it thrown, `bestMatches` — and therefore the archive — would never have run.
    expect(raced).toBe(true);
    expect(a.circleOf(deny.conceptId)).toBe("still-live");
    expect(fires(a, "still-live")).toBe(1);
    expect(a.ruleBinding(deny.conceptId)!.severity).toBe("blocking");

    spy.mockRestore();
    a.close();
    b.close();
  });

  it("SKIPS every relayed operation that would remove a live deny, counting rather than aborting", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    const deny = await liveDeny(src);
    dst.graftRows(src.exportDelta(0));
    expect(fires(dst)).toBe(1);

    const base = dst.exportDelta(0);
    // RELAYED RETIRE — a peer's tombstone must not retire a deny this machine enforces.
    const retire = dst.graftRows({ ...base, tombstones: [{ concept_id: deny.conceptId, retired_at: Date.now() + 1000 }] });
    expect(retire.skipped.tombstones).toBeGreaterThan(0);
    expect(fires(dst)).toBe(1);

    // RELAYED DELETE — the deletion EVENT still lands (the peer's act is on record); its local
    // effect on a live deny does not.
    const del = dst.graftRows({
      ...base,
      deletions: [{ concept_id: deny.conceptId, deleted_at: Date.now() + 2000, updated_at: Date.now() + 2000, writer_id: "machine-a", concept_kind: "native" }],
    });
    expect(del.skipped.deletions).toBeGreaterThan(0);
    expect(fires(dst)).toBe(1);

    // RELAYED CONTRADICTION (door 7) — local flagContradiction refuses rules, but this arrived by
    // sync and the status recompute would have disputed the rule straight out of the gate.
    const contra = dst.graftRows({
      ...base,
      contradictions: [{
        id: "peer-contra-1", concept_id: deny.conceptId, observation_id: null, kind: "value-conflict",
        status: "open", detail: "peer disagrees", resolution_obs_id: null, contradicted_observation_id: null,
        detected_at: Date.now(), resolved_at: null, resolved_by: null,
      }],
    });
    expect(contra.skipped.contradictions).toBeGreaterThan(0);
    expect(fires(dst)).toBe(1);
    expect(raw(dst).prepare(`SELECT COUNT(*) AS n FROM contradictions WHERE concept_id = ?`).get(deny.conceptId))
      .toEqual({ n: 0 });

    // RELAYED CORRECTION-BORN SUPERSESSION (door 9) — a peer must not be able to do by sync what
    // neither machine can do by hand: locally, correcting a blocking rule is refused outright.
    const successor = await src.store("A successor rule.", { kind: "rule", rule: { stage: "rm -rf", ...AGENT_RULE } });
    dst.graftRows(src.exportDelta(0));
    const edgeOf = (bornOf: string, id: string) => ({
      id, family: "supersession", src_concept_id: deny.conceptId, dst_concept_id: successor.conceptId,
      dst_span: null, born_of: bornOf, event_ref: "obs-x", circle: "default",
      created_at: Date.now(), sync_updated_at: Date.now(), sync_revision: 0, sync_writer: "machine-a",
    });
    const corrected = dst.graftRows({ ...dst.exportDelta(0), lifecycleEdges: [edgeOf("correction", "peer-edge-9")] });
    expect(corrected.skipped.lifecycle_edges).toBeGreaterThan(0);
    expect(fires(dst)).toBe(1);

    // ...and a DECLARATION-born edge is refused too, which is door 9 in full. The sender's act was
    // legitimate FOR THE SENDER — where the rule was advisory — but this replica declared the same
    // concept blocking, and A never knew. Two sovereign acts collided; relay does not pick a winner.
    const declaredElsewhere = dst.graftRows({ ...dst.exportDelta(0), lifecycleEdges: [edgeOf("declaration", "peer-edge-10")] });
    expect(declaredElsewhere.skipped.lifecycle_edges).toBeGreaterThan(0);
    expect(fires(dst)).toBe(1);

    // RELAYED RECLASSIFICATION (door 12) — the quietest of the twelve. severity stays 'blocking'
    // the whole time, so the demotion guard waves it through; scope and model_tag are rewritten
    // instead, turning a domain deny (which always fires) into a compensation for a model that is
    // not running, and the model-tag delivery filter drops it. Every row still reads "blocking".
    const bindingRow = dst.exportDelta(0).ruleBindings!.find((b) => b.concept_id === deny.conceptId)!;
    const reclassified = dst.graftRows({
      ...dst.exportDelta(0),
      ruleBindings: [{
        ...bindingRow, scope: "agent", model_tag: "some-other-model",
        sync_revision: (bindingRow.sync_revision ?? 0) + 5, sync_writer: "zzz-newer-writer",
      }],
    });
    expect(reclassified.skipped.rule_bindings).toBeGreaterThan(0);
    expect(dst.ruleBinding(deny.conceptId)).toMatchObject({ scope: bindingRow.scope, model_tag: bindingRow.model_tag });
    // The deny still fires under its ORIGINAL scope semantics — for the model it was declared for,
    // and (the attempted rewrite's target) not for the one the forged row tried to re-tag it to.
    const denies = (tag: string): string[] => dst
      .gate({ actionContext: "Bash:rm -rf /tmp/x", runtimeModelTag: tag })
      .rules.filter((r) => r.severity === "blocking").map((r) => r.conceptId);
    expect(denies(AGENT_RULE.modelTag)).toEqual([deny.conceptId]);
    expect(denies("some-other-model")).toEqual([]);

    // RELAYED STAGE RE-AIM (door 10) — the last member of the class. The chokepoint stops a relayed
    // act from REMOVING a deny; this stops one from silently changing what a deny denies, which is
    // the same authority reached by a different mechanism. Locally this needs
    // acknowledgeBlockingRules; a grafted row carries no acknowledgment.
    const stageId = dst.stages().find((st) => st.name === "rm -rf")!.id;
    const stageRow = dst.exportDelta(0).stages!.find((st) => st.id === stageId)!;
    const reaim = dst.graftRows({
      ...dst.exportDelta(0),
      stages: [{
        ...stageRow,
        trigger_patterns: JSON.stringify([{ tool: "bash", tokens: ["something", "else"] }]),
        sync_revision: (stageRow.sync_revision ?? 0) + 5,
        sync_writer: "zzz-newer-writer",
      }],
    });
    expect(reaim.skipped.stages).toBeGreaterThan(0);
    // The deny still fires on the patterns it was DECLARED against.
    expect(fires(dst)).toBe(1);
    expect(dst.stages().find((st) => st.id === stageId)!.patterns).toEqual([{ tool: "bash", tokens: ["rm", "-rf"] }]);

    // The LOCAL declaration path still withdraws it — that is the point of refusing the relay
    // rather than refusing the withdrawal: this machine decides about this machine's deny.
    await withdrawDeny(dst, deny.conceptId, "rm -rf");
    expect(fires(dst)).toBe(0);
    // ...and once it is no longer a live deny, the peer's edge relays like any other.
    const nowFree = dst.graftRows({ ...dst.exportDelta(0), lifecycleEdges: [edgeOf("declaration", "peer-edge-11")] });
    expect(nowFree.inserted.lifecycle_edges).toBeGreaterThan(0);
    src.close();
    dst.close();
  });

  it("keeps stage convergence flowing everywhere the re-aim guard does not apply", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    // An ADVISORY-only stage converges normally — the guard is about deny power, not about stages.
    await src.store("Pull before you push.", {
      kind: "rule", rule: { stage: "git push", instance: "Bash:git push", ...AGENT_RULE },
    });
    const deny = await src.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    dst.graftRows(src.exportDelta(0));

    await src.declare({ species: "stage", stage: "git push", patterns: ["Bash:git push --all"] });
    dst.graftRows(src.exportDelta(0));
    expect(dst.stages().find((st) => st.name === "git push")!.patterns)
      .toEqual([{ tool: "bash", tokens: ["git", "push", "--all"] }]);

    // A pattern-IDENTICAL row on a blocking-bound stage still converges, including verified-OR:
    // there is no re-aim in it, so there is nothing to refuse.
    // The verified flag is the proof: the guard `continue`s BEFORE the monotonic-OR update, so the
    // flag arriving at all means the row was not refused. (The row counts as skipped either way —
    // an unchanged replay loses the revision contest — which is why the counter cannot be the
    // assertion here.)
    expect(dst.stages().find((st) => st.name === "rm -rf")!.verified).toBe(false);
    src.gate({ actionContext: "Bash:rm -rf /tmp/x" }); // verifies the stage on the sender
    dst.graftRows(src.exportDelta(0));
    expect(dst.stages().find((st) => st.name === "rm -rf")!.verified).toBe(true);
    src.close();
    dst.close();
  });

  it("stops guarding the moment the deny is legitimately withdrawn", async () => {
    const c = resolvingCore();
    const deny = await liveDeny(c);
    expect(() => c.retireConcept(deny.conceptId)).toThrow(/blocking rule/);

    // PATH 1: declare it advisory. Cleanup is then ordinary maintenance, not a door.
    await withdrawDeny(c, deny.conceptId, "rm -rf");
    expect(fires(c)).toBe(0);
    expect(c.retireConcept(deny.conceptId)!.status).toBe("retired");

    // AND SUPERSESSION IS NOT A SECOND PATH (door 11). Superseding a LIVE deny is refused like
    // everything else: whether the act is legitimate is a question about the rule's state HERE, and
    // a caller holding a successor cannot answer it for a deny they may not have declared. Withdraw
    // first, then supersede — which is what a declare()-side successor surface will do in one act.
    const c2 = resolvingCore();
    const deny2 = await liveDeny(c2);
    const successor = await c2.store("Delete a tree only with an explicit confirmation.", {
      kind: "rule", rule: { stage: "rm -rf", ...AGENT_RULE },
    });
    const supersede = () => c2.addLifecycleEdge({
      family: "supersession", srcConceptId: deny2.conceptId, dstConceptId: successor.conceptId, bornOf: "declaration",
    });
    expect(supersede).toThrow(/would remove the blocking rule/);
    expect(fires(c2)).toBe(1);
    await withdrawDeny(c2, deny2.conceptId, "rm -rf");
    expect(supersede).not.toThrow();
    expect(fires(c2)).toBe(0);
    expect(c2.retireConcept(deny2.conceptId)!.status).toBe("retired");
    c2.close();
    c.close();
  });

  it("leaves ADVISORY rules and ordinary concepts completely alone", async () => {
    const c = resolvingCore();
    const advisory = await c.store("An advisory rule.", {
      kind: "rule", rule: { stage: "rm -rf", instance: "Bash:rm -rf", ...AGENT_RULE },
    });
    const fact = await c.store("An ordinary fact.", { kind: "fact" });
    // The guard is about deny power, not about rules in general — an advisory rule retires freely.
    expect(c.retireConcept(advisory.conceptId)!.status).toBe("retired");
    expect(c.flagContradiction(fact.conceptId, { detail: "conflicting" }).status).toBe("open");
    c.close();
  });
});

// ---------------------------------------------------------------------------
// DOOR 13: the breadth graft surface
// ---------------------------------------------------------------------------
/**
 * Doors 1-12 above guard a relayed row from quietly stripping a blocking rule's deny power. Breadth
 * reopened the same question one field over: circle is now ALSO protection scope — "*" reaches
 * every circle, unioned with local, no shadowing — so a relayed row that MINTS it, ESCALATES into
 * it, or REDUCES out of it is exactly as dangerous as one that mints, reclassifies, or removes a
 * deny, and needs the same discipline. This block is the review's own 8-item coverage sheet for that
 * surface, each item its own numbered test, run against the fixed code (BLOCKER B2, MATERIAL M4,
 * and the new named refusal in the circle_aliases graft loop).
 */
describe("DOOR 13: the breadth graft surface", () => {
  it("13.1 refuses '*' minted from every non-declaration origin, severity flipped to advisory to prove the circle check does not ride on the (separate) blocking-only guard", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const deny = await src.declare({
      circle: BREADTH_CIRCLE, species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking",
      reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    const payload = src.exportDelta(0);

    for (const origin of ["correction", "projection", "import"] as const) {
      const dst = core({ syncDeviceId: "machine-b" });
      const forged = {
        ...payload,
        ruleBindings: payload.ruleBindings!.map((b) =>
          b.concept_id === deny.conceptId ? { ...b, origin, severity: "advisory" } : b),
      };
      expect(() => dst.graftRows(forged as never), origin)
        .toThrow(/breadth is declaration-only and cannot be minted by sync/);
      dst.close();
    }
    src.close();
  });

  it("13.2 refuses a relayed CONCEPT with circle '*', for every concept kind — not only 'rule'", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const fact = await src.store("An ordinary fact.", { kind: "fact" });
    const insight = await src.store("An ordinary insight.", { kind: "insight" });
    const rule = await src.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "advisory", ...AGENT_RULE,
    });
    if (rule.species !== "rule") throw new Error("unreachable");
    const payload = src.exportDelta(0);

    for (const conceptId of [fact.conceptId, insight.conceptId, rule.conceptId]) {
      const dst = core({ syncDeviceId: "machine-b" });
      const forged = {
        ...payload,
        concepts: payload.concepts.map((c) => (c.id === conceptId ? { ...c, circle: BREADTH_CIRCLE } : c)),
        // Edges are irrelevant to what this test asks — an edge whose endpoint circle no longer
        // matches its own recorded scope trips an EARLIER, unrelated preflight
        // (assertGraftPayloadIsNativeOnly's edge-endpoint check) before this loop's own guard is
        // ever reached. Stripped so each attempt isolates the ONE thing under test: the CONCEPT
        // circle-minting guard, for a concept this store may have linked structurally.
        edges: [],
        edgeComponents: [],
      };
      expect(() => dst.graftRows(forged as never), conceptId)
        .toThrow(/never a circle a concept lives in/);
      dst.close();
    }
    src.close();
  });

  /**
   * REVISED (Codex round 10, item 1, P1): this test previously asserted that escalation from local
   * to '*' was held EVEN when the incoming row was declaration-origin and won the ordinary (revision,
   * writer) convergence contest — its own comment read "Relay does not get to widen its own reach;
   * only local declaration does." That was the exact bug this round's item 1 closes: a fabricated
   * row with `origin: 'declaration'` and a higher revision IS, by this system's own trust model,
   * indistinguishable from a genuine owner's later, recorded, legal re-declaration — the M4 hold's
   * job is to refuse a MERGE-time reclassification no row can be trusted to assert on its own, not to
   * refuse the owner's own act reaching a peer. See the M4 comment (engine.ts) for the full argument
   * and why `origin === 'declaration'` alone is not enough (must also WIN convergence, so a stale
   * declaration-origin replay cannot re-widen past a later, higher-revision act).
   */
  it("13.3 a legitimate widening (declaration-origin, wins convergence) now relays and lands; a FORGED one (any other origin) is still held outright, for BOTH incumbent severities", async () => {
    for (const startSeverity of ["blocking", "advisory"] as const) {
      const src = core({ syncDeviceId: "machine-a" });
      const rule = await src.declare({
        species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
        content: "Never delete a tree unattended.", severity: startSeverity,
        ...(startSeverity === "blocking" ? { reason: "there is no undo" } : {}),
        ...AGENT_RULE,
      });
      if (rule.species !== "rule") throw new Error("unreachable");
      const dst = core({ syncDeviceId: "machine-b" });
      dst.graftRows(src.exportDelta(0));
      expect(dst.ruleBinding(rule.conceptId)!.circle, startSeverity).toBe("default");

      // A later revision from the SAME lineage, declaration-origin, winning the ordinary convergence
      // contest — the shape a genuine owner's own re-declaration actually takes once relayed. Lands.
      const bindingRow = dst.exportDelta(0).ruleBindings!.find((b) => b.concept_id === rule.conceptId)!;
      const legit = dst.graftRows({
        ...dst.exportDelta(0),
        ruleBindings: [{
          ...bindingRow, circle: BREADTH_CIRCLE, origin: "declaration",
          sync_revision: (bindingRow.sync_revision ?? 0) + 5, sync_writer: "machine-a",
        }],
      });
      expect(legit.skipped.rule_bindings, startSeverity).toBe(0);
      expect(dst.ruleBinding(rule.conceptId)!.circle, startSeverity).toBe(BREADTH_CIRCLE);

      // THE FORGED SIBLING: identical shape, ONLY the origin differs (never declaration) — still
      // held, even with a revision that would otherwise win. Origin is the trust boundary here, not
      // revision alone (mirrors 13.1's own origin sweep, one level deeper — for an EXISTING binding).
      const bindingRow2 = dst.exportDelta(0).ruleBindings!.find((b) => b.concept_id === rule.conceptId)!;
      for (const origin of ["correction", "projection", "import"] as const) {
        const forged = dst.graftRows({
          ...dst.exportDelta(0),
          ruleBindings: [{
            // severity flipped to advisory (matching 13.1's own precedent): a non-declaration origin
            // can never legitimately claim blocking at all — an earlier, unrelated preflight
            // (assertGraftPayloadIsNativeOnly) refuses that combination outright, before the M4
            // check under test here is ever reached. Isolating THIS check means not tripping that one.
            ...bindingRow2, circle: "default", origin, severity: "advisory",
            sync_revision: (bindingRow2.sync_revision ?? 0) + 5, sync_writer: "machine-a",
          }],
        } as never);
        expect(forged.skipped.rule_bindings, `${startSeverity}/${origin}`).toBeGreaterThan(0);
        expect(dst.ruleBinding(rule.conceptId)!.circle, `${startSeverity}/${origin}`).toBe(BREADTH_CIRCLE);
      }
      src.close();
      dst.close();
    }
  });

  /**
   * REVISED (Codex round 10, item 1, P1), the "present" sub-case only: `bindingRow` here always
   * inherits `origin: 'declaration'` from the incumbent (every rule this test declares is
   * declaration-origin by construction), so the "present, different value" row this test already
   * fabricates — declaration-origin, a higher revision — is EXACTLY the shape a genuine owner's own
   * narrowing takes once relayed, not a forgery. It now lands, matching item 1's own fix. The
   * "absent" sub-case is UNCHANGED — BLOCKER B2 (an old-protocol peer's silence must never read as a
   * crossing attempt) is a completely separate concern this item does not touch, since `row.circle
   * === undefined` never reaches the M4 check at all.
   */
  it("13.4 a legitimate reduction from '*' to local (present, declaration-origin, wins convergence) now relays and lands; ABSENT circle still preserves breadth (BLOCKER B2, untouched); a FORGED reduction (non-declaration origin) is still held, for BOTH incumbent severities", async () => {
    for (const startSeverity of ["blocking", "advisory"] as const) {
      for (const circleField of ["present", "absent"] as const) {
        const label = `${startSeverity}/${circleField}`;
        const src = core({ syncDeviceId: "machine-a" });
        const rule = await src.declare({
          circle: BREADTH_CIRCLE, species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
          content: "Never delete a tree unattended.", severity: startSeverity,
          ...(startSeverity === "blocking" ? { reason: "there is no undo" } : {}),
          ...AGENT_RULE,
        });
        if (rule.species !== "rule") throw new Error("unreachable");
        const dst = core({ syncDeviceId: "machine-b" });
        dst.graftRows(src.exportDelta(0));
        expect(dst.ruleBinding(rule.conceptId)!.circle, label).toBe(BREADTH_CIRCLE);

        const bindingRow = dst.exportDelta(0).ruleBindings!.find((b) => b.concept_id === rule.conceptId)!;
        const forgedRow: Record<string, unknown> = {
          ...bindingRow, circle: "default",
          sync_revision: (bindingRow.sync_revision ?? 0) + 5, sync_writer: "machine-a",
        };
        if (circleField === "absent") {
          // Genuinely ABSENT, not present-and-undefined: a real old-protocol peer's JSON never has
          // the key at all — `circle` is optional on SyncRuleBindingRow for exactly this shape.
          delete forgedRow.circle;
        }
        const result = dst.graftRows({ ...dst.exportDelta(0), ruleBindings: [forgedRow] } as never);
        if (circleField === "present") {
          // declaration-origin + wins convergence — lands, exactly the owner-narrowing shape.
          expect(result.skipped.rule_bindings, label).toBe(0);
          expect(dst.ruleBinding(rule.conceptId)!.circle, label).toBe("default");

          // THE FORGED SIBLING, same present-circle shape, ONLY the origin differs — refused, but
          // NOT by the M4 escape this item adds: a non-declaration origin claiming circle '*' at
          // ALL is refused by the PRE-EXISTING '*'-minting preflight (assertGraftPayloadIsNativeOnly,
          // DOOR 13.1's own precedent), thrown before M4's own check is ever reached — a more
          // fundamental gate than this item's, and still fully in force. severity flipped to
          // advisory too (matching 13.1): a non-declaration origin can never legitimately claim
          // blocking either, a SEPARATE earlier preflight check.
          const bindingRow2 = dst.exportDelta(0).ruleBindings!.find((b) => b.concept_id === rule.conceptId)!;
          for (const origin of ["correction", "projection", "import"] as const) {
            expect(() => dst.graftRows({
              ...dst.exportDelta(0),
              ruleBindings: [{
                ...bindingRow2, circle: BREADTH_CIRCLE, origin, severity: "advisory",
                sync_revision: (bindingRow2.sync_revision ?? 0) + 5, sync_writer: "machine-a",
              }],
            } as never), `${label}/${origin}`).toThrow(/breadth is declaration-only and cannot be minted by sync/);
            expect(dst.ruleBinding(rule.conceptId)!.circle, `${label}/${origin}`).toBe("default");
          }
        } else {
          // ABSENT: BLOCKER B2, untouched by this item — silence is never a crossing attempt, so the
          // incumbent's breadth survives regardless of revision or origin.
          expect(dst.ruleBinding(rule.conceptId)!.circle, label).toBe(BREADTH_CIRCLE);
        }
        src.close();
        dst.close();
      }
    }
  });

  it("13.5 an old-protocol dangling deny (circle absent, reason absent) fires and discloses the moment its concept lands — no reopen required", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const deny = await src.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking",
      reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    const full = src.exportDelta(0);
    // Old-protocol: neither `circle` nor a reason ever existed on this wire.
    const oldProtocol = {
      ...full,
      ruleBindings: full.ruleBindings!.map((b) => {
        if (b.concept_id !== deny.conceptId) return b;
        const copy: Record<string, unknown> = { ...b, reason: null };
        delete copy.circle;
        return copy;
      }),
    };

    const dst = core({ syncDeviceId: "machine-b" });
    // Payload 1: stage + binding, concept withheld — the documented dangling-then-live gap.
    dst.graftRows({ ...oldProtocol, concepts: [], observations: [] } as never);
    expect(
      (raw(dst).prepare(`SELECT circle FROM rule_bindings WHERE concept_id = ?`).get(deny.conceptId) as { circle: string | null }).circle,
    ).toBeNull();

    // Payload 2: the concept arrives. NO REOPEN anywhere in this test — one MonetCore instance,
    // no fresh construction, no createGateSchema call: BLOCKER B3 closes the gap right here.
    dst.graftRows(oldProtocol as never);
    expect(dst.ruleBinding(deny.conceptId)!.circle).toBe("default");

    const fired = dst.gate({ actionContext: "Bash:rm -rf /tmp/x" });
    expect(fired.rules.map((r) => r.conceptId)).toEqual([deny.conceptId]);
    expect(fired.rules[0]).toMatchObject({ severity: "blocking", reasonMissing: true });

    expect(dst.gateStats("default").unexplainedDenies).toEqual([
      { conceptId: deny.conceptId, title: "Never delete a tree unattended", stageName: "rm -rf" },
    ]);
    src.close();
    dst.close();
  });

  it("13.6 a still-dangling NULL-circle binding is never a deliverable mirror entry", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const rule = await src.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking",
      reason: "there is no undo", ...AGENT_RULE,
    });
    if (rule.species !== "rule") throw new Error("unreachable");
    const full = src.exportDelta(0);
    // Old-protocol: `circle` never existed on this wire — the one shape that actually leaves the
    // binding NULL when its concept is withheld. A current-protocol row carries an explicit circle
    // always, which resolves the binding immediately via EFFECTIVE CIRCLE's own fallback regardless
    // of whether the concept exists yet — there would be nothing dangling to exclude.
    const oldProtocol = {
      ...full,
      ruleBindings: full.ruleBindings!.map((b) => {
        if (b.concept_id !== rule.conceptId) return b;
        const copy: Record<string, unknown> = { ...b };
        delete copy.circle;
        return copy;
      }),
    };
    const dst = core({ syncDeviceId: "machine-b" });
    dst.graftRows({ ...oldProtocol, concepts: [], observations: [] } as never);
    expect(
      (raw(dst).prepare(`SELECT circle FROM rule_bindings WHERE concept_id = ?`).get(rule.conceptId) as { circle: string | null }).circle,
    ).toBeNull();

    // Dangling right now: the row exists (it holds and guards nothing yet), but it must not be
    // OFFERED as a deliverable entry — minor m1's exclusion, at the exact moment it matters.
    const stale = dst.materializeGateMirror(join(mkTmp(), "m.json")).sidecar;
    expect(stale.entries).toEqual([]);

    // ...and the moment the concept lands, in the SAME store, it is admitted (BLOCKER B3) — proving
    // the exclusion above was the dangling row being genuinely absent, not a bug hiding it forever.
    dst.graftRows(oldProtocol as never);
    const settled = dst.materializeGateMirror(join(mkTmp(), "m.json")).sidecar;
    expect(settled.entries.map((e) => e.conceptId)).toEqual([rule.conceptId]);
    src.close();
    dst.close();
  });

  it("13.7 a legitimate '*' deny relays verbatim and fires in a circle the receiver never configured", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const deny = await src.declare({
      circle: BREADTH_CIRCLE, species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Never install without a lockfile present.", severity: "blocking",
      reason: "an unlocked install can pull an unreviewed transitive dependency", scope: "domain",
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    const dst = core({ syncDeviceId: "machine-b" });
    const result = dst.graftRows(src.exportDelta(0));
    expect(result.inserted.rule_bindings).toBe(1);
    expect(dst.ruleBinding(deny.conceptId)).toMatchObject({
      circle: BREADTH_CIRCLE, severity: "blocking", origin: "declaration",
    });

    const fired = dst.gate({ actionContext: "Bash:npm install", circle: "a-circle-the-receiver-never-configured" });
    expect(fired.rules.map((r) => r.conceptId)).toEqual([deny.conceptId]);
    src.close();
    dst.close();
  });

  it("13.8 refuses a relayed circle_aliases row naming '*' on either side", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    await src.store("Unrelated concept so 'named' is a real circle to rename.", { circle: "named", kind: "fact" });
    src.renameCircle("named", "canonical");
    const payload = src.exportDelta(0);
    const aliasRow = payload.circleAliases!.find((a) => a.from_name === "named")!;
    expect(aliasRow).toBeDefined();

    for (const forged of [
      { ...aliasRow, from_name: BREADTH_CIRCLE },
      { ...aliasRow, to_name: BREADTH_CIRCLE },
    ]) {
      const dst = core({ syncDeviceId: "machine-b" });
      expect(() => dst.graftRows({ ...payload, circleAliases: [forged] } as never), JSON.stringify(forged))
        .toThrow(/never a circle name an alias can hold on either side/);
      dst.close();
    }
    src.close();
  });

  /**
   * INHERITING BREADTH THROUGH SUPERSESSION IS NOT MINTING IT (Codex round 3, item 2d). Before this
   * fix, correcting a global rule threw outright — bindRule's own declaration-only guard could not
   * tell "succeedRule legitimately carrying an incumbent's '*' forward" from "an unrelated
   * correction-origin caller self-assigning global reach", so it refused BOTH, rolling the whole
   * correction back. A relayed row must get the identical protection: a peer who legitimately
   * corrected a global rule locally must not have that correction refused the moment it crosses the
   * wire, and a FORGED correction-origin '*' claim with no real supersession lineage must still be
   * refused exactly as before.
   */
  it("13.9 a legitimate inherited successor relays and fires globally; a forged correction-origin '*' row with no '*' predecessor lineage is refused (Codex round 3, item 2d)", async () => {
    // LEGITIMATE: correct a global advisory rule locally, then relay the successor's binding and
    // the supersession edge together — the ordinary shape one incremental export produces.
    const src = core({ syncDeviceId: "machine-a" });
    const original = await src.declare({
      circle: BREADTH_CIRCLE, species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Never install without a lockfile.", severity: "advisory", scope: "domain",
    });
    if (original.species !== "rule") throw new Error("unreachable");
    const corrected = await src.store("Never install without a lockfile present, even in CI.", {
      kind: "correction", attachTo: original.conceptId,
    });
    const dst = core({ syncDeviceId: "machine-b" });
    const payload = src.exportDelta(0);
    const result = dst.graftRows(payload);
    expect(result.skipped.rule_bindings).toBe(0);
    expect(dst.ruleBinding(corrected.conceptId)).toMatchObject({ circle: BREADTH_CIRCLE, origin: "correction" });
    expect(dst.gate({ actionContext: "Bash:npm install", circle: "a-circle-dst-never-configured" }).rules.map((r) => r.conceptId))
      .toEqual([corrected.conceptId]);

    // FORGED: an ordinary unrelated local rule, relayed with a hand-forged circle:'*'/
    // origin:'correction' claim and NO supersession edge anywhere — in this payload or already on
    // dst — naming it as anyone's successor.
    const src2 = core({ syncDeviceId: "machine-c" });
    const ordinary = await src2.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "An ordinary local rule.", severity: "advisory", scope: "domain",
    });
    if (ordinary.species !== "rule") throw new Error("unreachable");
    const ordinaryPayload = src2.exportDelta(0);
    const forged = {
      ...ordinaryPayload,
      ruleBindings: (ordinaryPayload.ruleBindings ?? []).map((b) =>
        b.concept_id === ordinary.conceptId ? { ...b, circle: BREADTH_CIRCLE, origin: "correction" } : b),
    };
    const dst2 = core({ syncDeviceId: "machine-d" });
    expect(() => dst2.graftRows(forged as never))
      .toThrow(/breadth is declaration-only and cannot be minted by sync/);

    src.close(); dst.close(); src2.close(); dst2.close();
  });

  /**
   * 13.10 THE DIVERGENT-CORRECTION RACE (Codex round 5, item 3, P1). Two replicas independently
   * correct the SAME global rule — each produces its OWN genuinely legitimate successor and
   * supersession edge, LOCALLY. The partial UNIQUE index on lifecycle_edges means only one edge can
   * ever land on a given receiver's store (the pre-existing divergent-successor convention:
   * incumbent wins, challenger's edge is skipped — see the edges loop's own comment, this file).
   * Before this fix, the CHALLENGER's rule_bindings row still landed globally regardless, because the
   * breadth-inheritance preflight only ever checked whether the challenger's OWN payload claimed a
   * supersession edge — true, and NOT FORGED — but not whether that edge actually SURVIVED the
   * receiver's own reconciliation moments later in the same transaction. Two divergent successors,
   * both firing everywhere, one with orphaned authority: no supersession edge anywhere in the
   * receiver's own store justified its breadth.
   *
   * CONVERGENCE, VERIFIED RATHER THAN ASSUMED: grafting the "winner's" delta back into the "loser"
   * does NOT retroactively correct the loser — each replica's own local edge is ITS OWN incumbent on
   * ITS OWN store, so "incumbent wins" resolves in the OPPOSITE direction on each side. The two
   * replicas genuinely cannot converge without human mediation (this is the PRE-EXISTING
   * divergent-successor semantics this fix does not change or attempt to close — "impeachment is a
   * later slice", the edges loop's own comment); this test pins the invariants that must hold
   * regardless of that divergence — nothing delivers twice, the receiver's own successor stays the
   * one live global rule, the challenger's binding is skipped and counted — not the divergence itself.
   */
  it("13.10 the divergent-correction race: the receiver's own successor stays the one live global rule, the challenger's binding is skipped and counted, nothing delivers twice, and grafting back does not retroactively converge either side (Codex round 5, item 3)", async () => {
    // Both replicas start from the SAME global rule — grafted from a common origin, not declared
    // twice, so both sides genuinely share one src_concept_id to diverge over.
    const origin = core({ syncDeviceId: "machine-origin" });
    const shared = await origin.declare({
      circle: BREADTH_CIRCLE, species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Never install without a lockfile.", severity: "advisory", scope: "domain",
    });
    if (shared.species !== "rule") throw new Error("unreachable");
    const originPayload = origin.exportDelta(0);

    const src = core({ syncDeviceId: "machine-a" });
    src.graftRows(originPayload);
    const challenger = core({ syncDeviceId: "machine-b" });
    challenger.graftRows(originPayload);

    // INDEPENDENT, LOCAL, LEGITIMATE corrections — neither replica has synced with the other yet.
    const successorA = await src.store("Never install without a lockfile present, even in CI.", {
      kind: "correction", attachTo: shared.conceptId,
    });
    const successorB = await challenger.store("Never install without a lockfile — verify its checksum too.", {
      kind: "correction", attachTo: shared.conceptId,
    });
    // Both verify as genuinely global, LOCALLY, on their own replica — the round 3 fix working
    // exactly as intended on each side taken alone.
    expect(src.ruleBinding(successorA.conceptId)).toMatchObject({ circle: BREADTH_CIRCLE, origin: "correction" });
    expect(challenger.ruleBinding(successorB.conceptId)).toMatchObject({ circle: BREADTH_CIRCLE, origin: "correction" });

    // THE RACE: src grafts challenger's delta. src already holds its OWN supersession edge
    // (shared -> successorA) as the incumbent, so the divergent-successor convention skips
    // challenger's edge (shared -> successorB) outright — proven directly below, not merely implied.
    const challengerPayload = challenger.exportDelta(0);
    const result = src.graftRows(challengerPayload);
    expect(result.skipped.lifecycle_edges).toBeGreaterThan(0);

    // THE FIX ITSELF: successorB's concept lands (the concepts loop is unconditional) but its
    // binding does not — skipped and counted, not landed as global, not silently downgraded to
    // local, not thrown.
    expect(result.skipped.rule_bindings).toBeGreaterThan(0);
    expect(await src.getConcept(successorB.conceptId)).not.toBeNull();
    expect(src.ruleBinding(successorB.conceptId)).toBeNull();
    // No surviving edge anywhere in src's own store names successorB as a successor either —
    // the exact fact verifiesInheritedBreadthInStore checks, confirmed directly against the row.
    expect(
      raw(src).prepare(`SELECT 1 FROM lifecycle_edges WHERE family = 'supersession' AND dst_concept_id = ?`).get(successorB.conceptId),
    ).toBeUndefined();

    // NOTHING DELIVERS TWICE: src's own successor is the one live global rule, everywhere —
    // including a circle this fixture never otherwise configured.
    expect(src.gate({ actionContext: "Bash:npm install", circle: "a-circle-src-never-configured" }).rules.map((r) => r.conceptId))
      .toEqual([successorA.conceptId]);

    // CONVERGENCE, VERIFIED: grafting src's delta back into challenger does NOT retroactively
    // correct the loser — challenger's OWN edge (shared -> successorB) is ITS OWN incumbent on ITS
    // OWN store, so src's edge (shared -> successorA) is what gets skipped THIS time, in the
    // opposite direction. Both replicas remain permanently, mutually divergent — the pre-existing
    // semantics this fix does not attempt to close.
    const srcPayload = src.exportDelta(0);
    const reverseResult = challenger.graftRows(srcPayload);
    expect(reverseResult.skipped.lifecycle_edges).toBeGreaterThan(0);
    expect(reverseResult.skipped.rule_bindings).toBeGreaterThan(0);
    expect(challenger.ruleBinding(successorA.conceptId)).toBeNull();
    expect(challenger.gate({ actionContext: "Bash:npm install", circle: "a-circle-challenger-never-configured" }).rules.map((r) => r.conceptId))
      .toEqual([successorB.conceptId]);

    origin.close(); src.close(); challenger.close();
  });

  /**
   * 13.11 THE FULL CONVERGENCE SEMANTICS (Codex round 10, item 1, P1) — not a fabricated row this
   * time, but a REAL two-store sequence: machine A performs a genuine local re-declaration (round 3's
   * legalized narrowing act), exports, and B's graft must agree — closing the exact bug this item
   * names ("machine A explicitly narrows a '*' rule via re-declaration... machine B's graft skips
   * the transition and the replicas diverge forever"). Then the other half: B's OWN stale copy of
   * A's PRE-narrowing state, replayed back at A after A has moved on, must not resurrect '*' — proving
   * `origin === 'declaration'` alone is not sufficient; the escape also requires WINNING the ordinary
   * convergence contest, so a stale replay of an earlier, lower-revision act cannot undo a later one.
   * Finally, a forged non-declaration-origin transition attempting the identical crossing is refused
   * outright, confirming origin — not revision — is what makes an act trustworthy here.
   *
   * `new MonetCore(..., { syncDeviceId })` WITH DEFAULT DEDUP, not `core()`'s disabled-dedup helper
   * (matching the existing "PATH 1 — breadth" precedent test above, not this describe block's own
   * convention) — deliberately: the second `declare()` call below must resolve to the SAME concept
   * as the first (identical stage + content), which default dedup guarantees and disabled dedup does
   * not (`core()`'s own comment: "every store() yields its own concept" — verified against PATH 1's
   * own working precedent before relying on it here, not assumed).
   */
  it("13.11 a legitimate owner narrowing relays and converges: B agrees; B's own stale ('*') delta replayed back at A does not resurrect it; a forged non-declaration transition is still held (Codex round 10, item 1)", async () => {
    const src = new MonetCore(":memory:", { syncDeviceId: "machine-a" });
    const rule = await src.declare({
      circle: BREADTH_CIRCLE, species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo",
      ...AGENT_RULE,
    });
    if (rule.species !== "rule") throw new Error("unreachable");
    const dst = new MonetCore(":memory:", { syncDeviceId: "machine-b" });
    dst.graftRows(src.exportDelta(0));
    expect(dst.ruleBinding(rule.conceptId)!.circle).toBe(BREADTH_CIRCLE);

    // B's STALE snapshot, taken HERE — while B still holds '*' — is what a delayed relay of B's own
    // state back to A would carry, later, after A has already moved on.
    const staleFromB = dst.exportDelta(0);

    // MACHINE A NARROWS ITS OWN RULE — a REAL local write, not a fabricated payload: an explicit
    // circle argument re-scoping what declare() itself already governs (round 3's legalized act).
    const narrowed = await src.declare({
      circle: "default", species: "rule", stage: "rm -rf",
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo",
      ...AGENT_RULE,
    });
    if (narrowed.species !== "rule") throw new Error("unreachable");
    expect(narrowed.conceptId).toBe(rule.conceptId); // same concept, same binding — confirmed, not assumed
    expect(narrowed).toMatchObject({ narrowedFromBreadth: true, previousCircle: BREADTH_CIRCLE });

    // THE BUG THIS ITEM CLOSES: A's narrowing relays and B agrees — previously held forever.
    const forward = dst.graftRows(src.exportDelta(0));
    expect(forward.skipped.rule_bindings).toBe(0);
    expect(dst.ruleBinding(rule.conceptId)!.circle).toBe("default");

    // B's OWN STALE DELTA, replayed back at A, does NOT resurrect '*': A has since moved to a HIGHER
    // revision, so the stale ('*', lower-revision, declaration-origin) row LOSES the ordinary
    // convergence contest — declaration origin alone was never enough, it must also win.
    const backAtA = src.graftRows(staleFromB);
    expect(backAtA.skipped.rule_bindings).toBeGreaterThan(0);
    expect(src.ruleBinding(rule.conceptId)!.circle).toBe("default");

    // A FORGED transition — non-declaration origin, a revision that WOULD otherwise win — is
    // refused, but NOT by the M4 escape this item adds: a non-declaration origin claiming circle
    // '*' at all is refused by the PRE-EXISTING '*'-minting preflight (assertGraftPayloadIsNativeOnly,
    // DOOR 13.1's own precedent), thrown before M4's own check is ever reached — a more fundamental
    // gate than this item's, and still fully in force; this loop confirms it composes correctly with
    // an EXISTING (already-narrowed) binding in play, not only a fresh one. severity flipped to
    // advisory too (matching 13.1): a non-declaration origin can never legitimately claim blocking
    // either, a separate earlier preflight check.
    const bindingRow = dst.exportDelta(0).ruleBindings!.find((b) => b.concept_id === rule.conceptId)!;
    for (const origin of ["correction", "projection", "import"] as const) {
      expect(() => dst.graftRows({
        ...dst.exportDelta(0),
        ruleBindings: [{
          ...bindingRow, circle: BREADTH_CIRCLE, origin, severity: "advisory",
          sync_revision: (bindingRow.sync_revision ?? 0) + 5, sync_writer: "machine-a",
        }],
      } as never), origin).toThrow(/breadth is declaration-only and cannot be minted by sync/);
      expect(dst.ruleBinding(rule.conceptId)!.circle, origin).toBe("default");
    }
    src.close();
    dst.close();
  });

  /**
   * COMPOSING ROUND 10's NARROWING-LANDS WITH ROUND 1's CONCEPT-IS-TRUTH (Codex round 11, item 6,
   * P1). 13.4 and 13.11 above both prove an admitted narrowing LANDS; neither one ever gives the
   * concept a circle different from what the row itself claims, so neither notices that the landed
   * VALUE was simply the row's own claim, never cross-checked against the concept. This test forces
   * the divergence: B's own copy of the concept lives at 'y', entirely independent of sync, and A's
   * relayed narrowing claims 'x' — the concept is the truth, exactly as it already is outside breadth
   * (the NON-BREADTH REGIME just below in graftRows).
   */
  it("13.12 an admitted declaration-origin narrowing lands at the CONCEPT's own actual circle on the receiver, not the row's claimed circle, when the two diverge (Codex round 11, item 6)", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const rule = await src.declare({
      circle: BREADTH_CIRCLE, species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "advisory", ...AGENT_RULE,
    });
    if (rule.species !== "rule") throw new Error("unreachable");

    const dst = core({ syncDeviceId: "machine-b" });
    dst.graftRows(src.exportDelta(0));
    expect(dst.ruleBinding(rule.conceptId)!.circle).toBe(BREADTH_CIRCLE);

    // B's OWN CONCEPT MOVES, LOCALLY, INDEPENDENT OF SYNC — a plain reassignment, nothing to do with
    // the binding's own breadth. The concept now lives at 'y' on B; the binding stays '*' — a global
    // binding never follows its concept (trg_rule_bindings_follow_concept_circle's own `circle !=
    // '*'` guard, gates.ts; the same invariant DOOR 13's old-build UPDATE test above already relies
    // on for the identical reason).
    dst.reassignCircle(rule.conceptId, "y");
    expect(dst.ruleBinding(rule.conceptId)!.circle).toBe(BREADTH_CIRCLE);

    // MACHINE A NARROWS ITS OWN RULE TO 'x' — a legitimate owner act (round 10's own M4 escape),
    // relayed to B. B has never heard of 'x'; its own concept lives at 'y'.
    const bindingRow = dst.exportDelta(0).ruleBindings!.find((b) => b.concept_id === rule.conceptId)!;
    const narrowedRow: Record<string, unknown> = {
      ...bindingRow, circle: "x", origin: "declaration",
      sync_revision: (bindingRow.sync_revision ?? 0) + 5, sync_writer: "machine-a",
    };
    const result = dst.graftRows({ ...dst.exportDelta(0), ruleBindings: [narrowedRow] } as never);

    // ADMITTED, not skipped — M4's own boundary check let it cross.
    expect(result.skipped.rule_bindings).toBe(0);
    // BUT LANDS AT 'y', the concept's own actual circle on B — NOT 'x', the row's mere claim.
    expect(dst.ruleBinding(rule.conceptId)!.circle).toBe("y");
    // And it delivers from 'y', never from 'x' — the divergence would otherwise silently move the
    // rule's delivery to a circle its own concept never actually lived in on this store.
    expect(dst.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: "y" }).rules.map((r) => r.conceptId))
      .toContain(rule.conceptId);
    expect(dst.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: "x" }).rules.map((r) => r.conceptId))
      .not.toContain(rule.conceptId);

    src.close();
    dst.close();
  });

  /**
   * CASE (d) OF THE POST-MERGE MATRIX (P1): 13.12 above proves an admitted narrowing lands at the
   * concept's TRUE circle when the concept already EXISTS on the receiver. This is the sibling case
   * the coordinator's own re-derivation named: the concept has NOT arrived AT ALL when the admitted
   * narrowing itself lands. Before this fix, that fallback chain's last resort was `row.circle ??
   * current?.circle` — freezing the row's own unverifiable claim (or, worse, `current?.circle`,
   * which is PROVABLY always '*' here by `admittedNarrowing`'s own definition, silently neutralizing
   * the very narrowing just admitted). The fix: NULL, same as case (c) — preserves the narrowing's
   * effect (NULL is not '*') without guessing, and lets BLOCKER B3 heal it to wherever the concept
   * actually lands once it arrives.
   */
  it("13.13 an admitted narrowing arrives while its own concept is STILL dangling — the binding lands NULL (never the row's claim, never a frozen '*'), and heals to wherever the concept actually lands, even when that differs from the narrowing's own claim (post-merge review round, P1, item d)", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const rule = await src.declare({
      circle: BREADTH_CIRCLE, species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "advisory", ...AGENT_RULE,
    });
    if (rule.species !== "rule") throw new Error("unreachable");

    // BINDING-FIRST GRAFT, GLOBAL: dst has never heard of this concept OR binding before — the
    // ordinary breadth regime (not yet an admitted narrowing; this is a fresh bind), unaffected by
    // this round's fix: lands at '*', dangling.
    const dst = core({ syncDeviceId: "machine-b" });
    dst.graftRows({ ...src.exportDelta(0), concepts: [] } as never);
    expect(dst.ruleBinding(rule.conceptId)!.circle).toBe(BREADTH_CIRCLE);
    expect(raw(dst).prepare(`SELECT 1 FROM concepts WHERE id = ?`).get(rule.conceptId)).toBeUndefined();

    // MACHINE A NARROWS ITS OWN RULE TO 'claimed-by-narrow' — a legitimate M4-admitted act — relayed
    // to B, STILL with no concept graft (deliberately withheld).
    const bindingRow = dst.exportDelta(0).ruleBindings!.find((b) => b.concept_id === rule.conceptId)!;
    const narrowedRow: Record<string, unknown> = {
      ...bindingRow, circle: "claimed-by-narrow", origin: "declaration",
      sync_revision: (bindingRow.sync_revision ?? 0) + 5, sync_writer: "machine-a",
    };
    const result = dst.graftRows({ ...dst.exportDelta(0), concepts: [], ruleBindings: [narrowedRow] } as never);
    expect(result.skipped.rule_bindings).toBe(0); // ADMITTED, not skipped — M4's own boundary check.

    // NULL — THE FIX. Never 'claimed-by-narrow' (unverifiable while the concept is absent) and never
    // '*' (current?.circle, which would silently neutralize the very narrowing just admitted).
    const stillDangling = raw(dst).prepare(`SELECT circle FROM rule_bindings WHERE concept_id = ?`).get(rule.conceptId) as { circle: string | null };
    expect(stillDangling.circle).toBeNull();
    expect(dst.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: "claimed-by-narrow" }).rules.map((r) => r.conceptId))
      .not.toContain(rule.conceptId);

    // A CONCURRENT MOVE WINS ELSEWHERE, before the concept ever reaches B: it lands at
    // 'actual-circle' on the source — DIFFERENT from what the narrowing row claimed.
    src.reassignCircle(rule.conceptId, "actual-circle");
    // THE CONCEPT FINALLY ARRIVES — concept-only, matching the established B3 technique.
    dst.graftRows({ ...src.exportDelta(0), ruleBindings: [] } as never);

    // HEALS TO 'actual-circle' — the concept's own real circle — never 'claimed-by-narrow'.
    const healed = raw(dst).prepare(`SELECT circle FROM rule_bindings WHERE concept_id = ?`).get(rule.conceptId) as { circle: string | null };
    expect(healed.circle).toBe("actual-circle");
    expect(dst.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: "actual-circle" }).rules.map((r) => r.conceptId))
      .toContain(rule.conceptId);
    expect(dst.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: "claimed-by-narrow" }).rules.map((r) => r.conceptId))
      .not.toContain(rule.conceptId);

    src.close();
    dst.close();
  });
});

// ---------------------------------------------------------------------------
// correcting a global rule inherits its breadth, not just its content
// ---------------------------------------------------------------------------
/**
 * Codex round 3, item 2. succeedRule already passed the incumbent's circle to the successor
 * unconditionally (inheritance was always the code's intent), but bindRule's own declaration-only
 * breadth guard could not tell that apart from an unrelated caller minting '*' via a bare
 * correction, and the schema CHECK would have rejected the write regardless — so correcting a
 * global rule rolled the ENTIRE correction back: no successor, no supersession edge, nothing. Fixed
 * through the full chain: the schema CHECK widens to accept correction-origin '*' (item 2a),
 * bindRule verifies the claim via a `predecessorCircle` succeedRule threads through rather than
 * bindRule inferring it (item 2b), and the graft preflight extends the identical governed exception
 * to a relayed successor (item 2c, tested in DOOR 13.9 above).
 */
describe("correcting a global rule inherits its breadth, not just its content", () => {
  it("correcting a global ADVISORY rule succeeds: the successor is '*', fires everywhere, and the supersession edge + disclosure are intact", async () => {
    const c = core();
    const original = await c.declare({
      circle: BREADTH_CIRCLE, species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Never install without a lockfile.", severity: "advisory", scope: "domain",
    });
    if (original.species !== "rule") throw new Error("unreachable");
    expect(c.ruleBinding(original.conceptId)!.circle).toBe(BREADTH_CIRCLE);

    const corrected = await c.store("Never install without a lockfile present, even in CI.", {
      kind: "correction", attachTo: original.conceptId,
    });
    // DISCLOSURE: the supersession is reported, not merely performed.
    expect(corrected.ruleSuccession).toMatchObject({
      supersededRuleId: original.conceptId, successorRuleId: corrected.conceptId,
    });
    // THE SUPERSESSION EDGE actually exists and names the right pair.
    const edge = raw(c).prepare(
      `SELECT src_concept_id, dst_concept_id, family FROM lifecycle_edges WHERE id = ?`,
    ).get(corrected.ruleSuccession!.supersessionEdgeId) as { src_concept_id: string; dst_concept_id: string; family: string };
    expect(edge).toMatchObject({ src_concept_id: original.conceptId, dst_concept_id: corrected.conceptId, family: "supersession" });
    // THE SUCCESSOR INHERITS BREADTH — the fix itself.
    expect(c.ruleBinding(corrected.conceptId)).toMatchObject({ circle: BREADTH_CIRCLE, origin: "correction", severity: "advisory" });
    // FIRES EVERYWHERE, including a circle this fixture never otherwise touches.
    expect(c.gate({ actionContext: "Bash:npm install", circle: "a-circle-nothing-else-touches" }).rules.map((r) => r.conceptId))
      .toEqual([corrected.conceptId]);
    // THE OLD RULE IS HISTORY — active, searchable, never injected again (existing doctrine,
    // unaffected by this fix — confirmed still true for a GLOBAL predecessor specifically).
    expect((await c.getConcept(original.conceptId))!.status).toBe("active");
    expect(c.gate({ actionContext: "Bash:npm install", circle: "default" }).rules.map((r) => r.conceptId))
      .toEqual([corrected.conceptId]); // the OLD concept id never appears
    c.close();
  });

  /**
   * DISAGREEMENT WITH THE REVIEW'S OWN PREMISE, STATED PLAINLY: the review asked for this same test
   * "for a global BLOCKING rule (which additionally requires the acknowledgment door — verify the
   * two guards compose rather than fight)". Investigated directly (ruleCorrectionVerdict, engine.ts)
   * rather than assumed: there is no acknowledgment door that unlocks blocking-rule correction.
   * `ruleCorrectionVerdict` returns `"blocking"` — refused, UNCONDITIONALLY — for ANY blocking
   * incumbent, by explicit design ("Declaration is the only mutation path for a blocking rule, in
   * both directions" — that function's own comment). `acknowledgeBlockingRules` is a REAL mechanism
   * in this codebase, but for a different door entirely (re-authoring a STAGE's trigger patterns
   * when blocking rules are bound to it — assertNoUnacknowledgedDenies), not for unlocking
   * correction-based supersession of a blocking rule's CONTENT. succeedRule's own doc comment
   * already states the successor "cannot inherit blocking severity, because the incumbent could
   * never have been blocking" — this is a confirmed, pre-existing, deliberate invariant, not a gap
   * this round's fix should touch. What this test proves instead: that invariant survives this fix
   * completely unchanged — a global BLOCKING rule is exactly as refused-by-correction as a local
   * one, for the SAME declaration-only reason, with no interaction with breadth at all.
   */
  it("correcting a global BLOCKING rule is still refused, unconditionally — declaration-only, unrelated to breadth (a correction to the review's own premise, not a gap this fix should close)", async () => {
    const c = core();
    const deny = await c.declare({
      circle: BREADTH_CIRCLE, species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Never install without a lockfile.", severity: "blocking", reason: "unlocked installs drift",
      scope: "domain",
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    await expect(
      c.store("A challenger observation.", { kind: "correction", attachTo: deny.conceptId }),
    ).rejects.toThrow(/blocking rule.*cannot be corrected/s);
    // UNCHANGED: still blocking, still global, still firing — the refusal left it exactly as it was.
    expect(c.ruleBinding(deny.conceptId)).toMatchObject({ severity: "blocking", circle: BREADTH_CIRCLE });
    expect(c.gate({ actionContext: "Bash:npm install", circle: "a-circle-nothing-else-touches" }).rules.map((r) => r.conceptId))
      .toEqual([deny.conceptId]);
    c.close();
  });
});

// ---------------------------------------------------------------------------
// relayed circle divergence: the concept is authoritative (Codex round 1, item 3)
// ---------------------------------------------------------------------------
/**
 * A DIFFERENT invariant than DOOR 13's, though it lives in the same loop: this is LOCAL-to-LOCAL,
 * never '*' on either side. Once delivery started trusting `rule_bindings.circle` (for breadth's
 * sake — a binding's circle can legitimately diverge from its concept's ONLY when it is breadth), a
 * relayed row claiming a DIFFERENT ordinary circle than its own concept — declaration-origin, a
 * legitimately higher revision, every DOOR 12 field unchanged, only circle diverging — landed
 * untouched by every existing guard (DOOR 12 watches stage/scope/tag; the boundary check watches
 * for '*' crossing a boundary) and silently moved the deny's delivery away from the circle its
 * concept actually lives in. The fix restores the invariant that made pre-breadth delivery safe:
 * for a NON-breadth binding, the concept's own circle is the truth, converged to silently (no skip
 * counter — this is not a reclassification act, the row is simply wrong about a fact the concept
 * already settles) whenever the concept exists.
 */
describe("relayed circle divergence: the concept is authoritative", () => {
  it("a relayed row claiming a DIFFERENT local circle than its own concept converges to the concept — the deny STAYS in the concept's actual circle and still fires there (Codex round 1, item 3)", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const deny = await src.declare({
      circle: "circle-a", species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    const dst = core({ syncDeviceId: "machine-b" });
    dst.graftRows(src.exportDelta(0)); // dst holds the incumbent; concept lives in "circle-a"
    expect(dst.ruleBinding(deny.conceptId)!.circle).toBe("circle-a");

    // A later revision, same lineage, declaration-origin, EVERY door-12 field unchanged — claiming
    // ONLY a different LOCAL circle. The concept itself does NOT move in this payload.
    const bindingRow = dst.exportDelta(0).ruleBindings!.find((b) => b.concept_id === deny.conceptId)!;
    const result = dst.graftRows({
      ...dst.exportDelta(0),
      ruleBindings: [{
        ...bindingRow, circle: "circle-b",
        sync_revision: (bindingRow.sync_revision ?? 0) + 5, sync_writer: "machine-a",
      }],
    });
    // NOT held (the boundary-check shape is for '*' crossing a boundary; this is local-to-local) —
    // the row converges silently to the concept's own circle, with no skip counter.
    expect(result.skipped.rule_bindings).toBe(0);
    expect(result.inserted.rule_bindings).toBe(1);
    expect(dst.ruleBinding(deny.conceptId)!.circle).toBe("circle-a");
    expect((raw(dst).prepare(`SELECT circle FROM concepts WHERE id = ?`).get(deny.conceptId) as { circle: string }).circle)
      .toBe("circle-a");
    expect(dst.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: "circle-a" }).rules.map((r) => r.conceptId))
      .toEqual([deny.conceptId]);
    expect(dst.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: "circle-b" }).rules).toEqual([]);
    src.close();
    dst.close();
  });

  it("a legitimate move — the concept row ALSO moves circles in the SAME payload — the binding follows it (Codex round 1, item 3)", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const deny = await src.declare({
      circle: "circle-a", species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    const dst = core({ syncDeviceId: "machine-b" });
    dst.graftRows(src.exportDelta(0));
    expect(dst.ruleBinding(deny.conceptId)!.circle).toBe("circle-a");

    // src moves the concept locally, then relays both the concept AND its binding together.
    src.reassignCircle(deny.conceptId, "circle-b");
    const payload = src.exportDelta(0);
    expect(payload.concepts.find((c) => c.id === deny.conceptId)?.circle).toBe("circle-b");
    const result = dst.graftRows(payload);
    expect(result.skipped.rule_bindings).toBe(0);
    expect(dst.ruleBinding(deny.conceptId)!.circle).toBe("circle-b");
    expect(dst.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: "circle-b" }).rules.map((r) => r.conceptId))
      .toEqual([deny.conceptId]);
    expect(dst.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: "circle-a" }).rules).toEqual([]);
    src.close();
    dst.close();
  });

  it("the SAME divergence, for an ADVISORY binding — non-breadth means non-breadth regardless of severity too (Codex round 1, item 3)", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const rule = await src.declare({
      circle: "circle-a", species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Confirm before deleting.", severity: "advisory", ...AGENT_RULE,
    });
    if (rule.species !== "rule") throw new Error("unreachable");
    const dst = core({ syncDeviceId: "machine-b" });
    dst.graftRows(src.exportDelta(0));
    expect(dst.ruleBinding(rule.conceptId)!.circle).toBe("circle-a");

    const bindingRow = dst.exportDelta(0).ruleBindings!.find((b) => b.concept_id === rule.conceptId)!;
    const result = dst.graftRows({
      ...dst.exportDelta(0),
      ruleBindings: [{
        ...bindingRow, circle: "circle-b",
        sync_revision: (bindingRow.sync_revision ?? 0) + 5, sync_writer: "machine-a",
      }],
    });
    expect(result.skipped.rule_bindings).toBe(0);
    expect(dst.ruleBinding(rule.conceptId)!.circle).toBe("circle-a");
    expect(dst.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: "circle-a" }).rules.map((r) => r.conceptId))
      .toEqual([rule.conceptId]);
    src.close();
    dst.close();
  });

  /**
   * THE THIRD CASE OF THIS SAME INVARIANT, NEVER EXERCISED ABOVE (post-merge review round, P1): both
   * tests above hold `dst` already carrying the concept (case (a) — conceptCircle wins). This is
   * case (c) — NEITHER the concept NOR any incumbent binding exists on `dst` yet when the BINDING
   * itself arrives first. Before this fix, the non-breadth regime's own fallback chain's last resort
   * was `row.circle` — freezing the sender's own claim into a REAL (non-NULL) value the moment the
   * binding landed, which BLOCKER B3 (below, this same function) can never revisit once it holds
   * anything but NULL. A concurrent move elsewhere, landing the concept at a DIFFERENT circle before
   * it ever reaches this receiver, left the binding wrong FOREVER — silently, since a frozen non-NULL
   * value is indistinguishable from a correctly-resolved one to every later read.
   */
  it("a binding-first graft: the row claims one circle while dangling, but its concept later lands in a DIFFERENT circle — the binding heals to the concept's ACTUAL circle, never freezing the row's stale claim (post-merge review round, P1)", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const rule = await src.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Confirm the lockfile before installing.", severity: "advisory", scope: "domain",
      circle: "claimed",
    });
    if (rule.species !== "rule") throw new Error("unreachable");
    expect(src.ruleBinding(rule.conceptId)!.circle).toBe("claimed");

    // BINDING-FIRST GRAFT: only the rule_bindings row crosses, its own concept stripped — the
    // dangling-then-live gap, deliberately provoked (mirroring the existing "dangling composition"
    // test's own concept-only technique, in reverse).
    const dst = core({ syncDeviceId: "machine-b" });
    dst.graftRows({ ...src.exportDelta(0), concepts: [] } as never);

    // NULL, not 'claimed' — the fix itself (was `row.circle` before this round).
    const dangling = raw(dst).prepare(`SELECT circle FROM rule_bindings WHERE concept_id = ?`).get(rule.conceptId) as { circle: string | null };
    expect(dangling.circle).toBeNull();
    expect(dst.gate({ actionContext: "Bash:npm install", circle: "claimed" }).rules.map((r) => r.conceptId))
      .not.toContain(rule.conceptId);

    // A CONCURRENT MOVE WINS ELSEWHERE, before the receiver ever sees the concept at all.
    src.reassignCircle(rule.conceptId, "actual");
    expect(src.ruleBinding(rule.conceptId)!.circle).toBe("actual"); // the binding followed, on the source

    // THE CONCEPT ARRIVES — concept-only, matching the established B3 technique — reflecting its
    // NEW circle, never the one the earlier binding-first graft claimed.
    dst.graftRows({ ...src.exportDelta(0), ruleBindings: [] } as never);

    // HEALS TO 'actual' — the concept's own real circle — never 'claimed', the row's stale guess.
    const healed = raw(dst).prepare(`SELECT circle FROM rule_bindings WHERE concept_id = ?`).get(rule.conceptId) as { circle: string | null };
    expect(healed.circle).toBe("actual");
    expect(dst.gate({ actionContext: "Bash:npm install", circle: "actual" }).rules.map((r) => r.conceptId))
      .toContain(rule.conceptId);
    expect(dst.gate({ actionContext: "Bash:npm install", circle: "claimed" }).rules.map((r) => r.conceptId))
      .not.toContain(rule.conceptId);
    src.close();
    dst.close();
  });

  /**
   * A DIFFERENT bug than item 3's own, found WHILE writing that fix's "legitimate move" test above:
   * renameCircle's (and moveConcept's) parallel `UPDATE rule_bindings SET circle = ?` carried no sync
   * stamp at all — unlike `concepts`, `rule_bindings` has no automatic sync trigger, so a raw UPDATE
   * against it is invisible to sync unless it stamps sync_updated_at/sync_revision/sync_writer
   * itself (the way bindRule's own UPDATE branch already does). A rename relayed to a peer moved the
   * CONCEPT (the concepts trigger caught that) while the BINDING stayed pointed at the OLD circle
   * name on every other device FOREVER — not merely stale until an unrelated touch, genuinely
   * permanent, since a row an incremental export never re-selects gets no second chance to converge.
   * NOT one of Codex round 1's 4 named findings; fixed here because item 3's own explicitly
   * requested "binding follows a legitimate move" scenario cannot be true without it.
   */
  it("renameCircle's rule_bindings update is stamped for sync too — a rename relayed to a peer moves the binding, not only the concept", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const deny = await src.declare({
      circle: "circle-a", species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    const dst = core({ syncDeviceId: "machine-b" });
    dst.graftRows(src.exportDelta(0));
    expect(dst.ruleBinding(deny.conceptId)!.circle).toBe("circle-a");

    src.renameCircle("circle-a", "circle-renamed");
    const payload = src.exportDelta(0);
    expect(payload.ruleBindings!.find((b) => b.concept_id === deny.conceptId)?.circle).toBe("circle-renamed");
    const result = dst.graftRows(payload);
    expect(result.skipped.rule_bindings).toBe(0);
    expect(result.inserted.rule_bindings).toBe(1);
    expect(dst.ruleBinding(deny.conceptId)!.circle).toBe("circle-renamed");
    expect(dst.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: "circle-renamed" }).rules.map((r) => r.conceptId))
      .toEqual([deny.conceptId]);
    src.close();
    dst.close();
  });
});

describe("the sidecar generation contract", () => {
  const read = (path: string): GateMirror => JSON.parse(readFileSync(path, "utf8")) as GateMirror;

  it("bumps exactly once per mutation class, and not at all for unrelated writes", async () => {
    const c = resolvingCore();
    const at = (): number => c.sidecarGeneration();
    const start = at();

    // AN ADVISORY RULE IS MIRROR CONTENT TOO, as of format 4 (entries carries every live rule, both
    // severities — no longer "an advisory rule is not deny power: nothing to mirror, nothing to
    // bump", which was the correct read only while the mirror was blocking-only). This one call
    // creates a NEW stage ("rm -rf" did not exist) AND a new binding — two mirror-relevant writes,
    // two bumps. An ordinary FACT touches neither `stages` nor `rule_bindings`, so it still bumps
    // nothing — that half of "not at all for unrelated writes" is unchanged.
    await c.store("An advisory rule.", { kind: "rule", rule: { stage: "rm -rf", instance: "Bash:rm -rf", ...AGENT_RULE } });
    const afterAdvisoryRule = at();
    expect(afterAdvisoryRule).toBe(start + 2);
    await c.store("An ordinary fact.", { kind: "fact" });
    expect(at()).toBe(afterAdvisoryRule);

    // 1. a blocking binding appears, on a NEW stage — new stage (+1) and new binding (+1), same as
    //    the advisory case above: severity does not change what counts as mirror-relevant creation.
    const deny = await c.declare({
      species: "rule", stage: "terraform apply", patterns: ["terraform apply"],
      content: "Never apply without a plan review.", severity: "blocking",
      reason: "an unreviewed apply changes infrastructure nobody agreed to change", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    const afterDeclare = at();
    expect(afterDeclare).toBe(afterAdvisoryRule + 2);

    // 2. patterns change on a stage that carries a deny — unchanged from before: a stage carrying a
    //    live blocking rule already bumped under the old, narrower gate, and still does under the
    //    new, wider one (every stage's patterns are mirror content now, not only a denying stage's).
    await c.declare({
      species: "stage", stage: "terraform apply", patterns: ["terraform apply", "terraform destroy"],
      acknowledgeBlockingRules: [deny.conceptId],
    });
    const afterPatterns = at();
    expect(afterPatterns).toBe(afterDeclare + 1);
    // ...but a no-op re-declaration of the SAME patterns changes nothing, so it bumps nothing —
    // upsertStage's own no-op guard (`nextPatterns === existing.trigger_patterns`) short-circuits
    // before any bump decision is even reached, unaffected by this slice's widening.
    await c.declare({
      species: "stage", stage: "terraform apply", patterns: ["terraform apply", "terraform destroy"],
      acknowledgeBlockingRules: [deny.conceptId],
    });
    expect(at()).toBe(afterPatterns);

    // 3. moving the rule between circles rewrites the entry's `circle` field — unchanged: this rule
    //    is blocking, so both the old and new liveness predicate agree it is mirror-relevant.
    c.reassignCircle(deny.conceptId, "elsewhere");
    const afterMove = at();
    expect(afterMove).toBe(afterPatterns + 1);

    // 4. an explicit downgrade — the only way to take deny power off a live rule. +2, not +1, as of
    //    Codex round 10, items 2+3: withdrawDeny's own store() call reaches bindRule's "replace"
    //    branch, changing `severity` — one of the seven columns `trg_rule_bindings_bump_on_
    //    reclassification` now also watches. That trigger composes with bindRule's OWN kept bump
    //    (see that branch's own comment, gates.ts, for why — unlike every other case in this
    //    family — the JS-side call could not be safely removed) rather than replacing it: a
    //    genuine, single reclassification act now bumps twice, an accepted, documented cost, not a
    //    regression. `afterDowngrade` still anchors every later delta below by its own actual value,
    //    not by a hardcoded absolute, so nothing downstream needed to change.
    await withdrawDeny(c, deny.conceptId, "terraform apply", "elsewhere");
    const afterDowngrade = at();
    expect(afterDowngrade).toBe(afterMove + 2);

    // 5. RETIRE, now that the deny has been withdrawn and retirement is ordinary cleanup. THIS is
    //    where format 4 changes the count: the rule is ADVISORY now (not blocking) since step 4, so
    //    the OLD blocking-only gate (hasBlockingBinding) would have seen no bump owed here — "the
    //    rule stopped being in the mirror at the downgrade" was true when the mirror was
    //    blocking-only. It is NOT true any more: the advisory rule is very much in `entries` after
    //    the downgrade, and retiring it is what removes it now — so THIS bumps, where it used not to.
    c.retireConcept(deny.conceptId);
    const afterRetire = at();
    expect(afterRetire).toBe(afterDowngrade + 1);

    // ...and an ordinary NEW advisory rule write ALSO bumps now — on the EXISTING "rm -rf" stage, so
    // only the binding is new (+1, not +2). This is the other half of what "not at all for unrelated
    // writes" used to mean: an all-advisory write was UNRELATED to a blocking-only mirror. It is not
    // unrelated to this one. Text deliberately dissimilar from "An advisory rule." above — this is
    // resolvingCore, and a near-paraphrase would resolve onto the SAME concept (bindRule's `keep`
    // branch, a genuine no-op that bumps nothing), which would test attach-dedup instead of this.
    await c.store("Confirm before force-deleting a mounted volume.", { kind: "rule", rule: { stage: "rm -rf", ...AGENT_RULE } });
    const afterNewAdvisoryRule = at();
    expect(afterNewAdvisoryRule).toBe(afterRetire + 1);
    // A FACT remains genuinely unrelated: it never touches stages or rule_bindings, retired or not.
    c.retireConcept((await c.store("A throwaway fact.", { kind: "fact" })).conceptId);
    expect(at()).toBe(afterNewAdvisoryRule);
    c.close();
  });

  /**
   * THE MIRROR MUST STOP GOING STALE ON A RETITLE, EVERYWHERE ONE CAN HAPPEN (Codex round 6, item 1;
   * closing the family round 2, item 4 opened). noteRuleTouched bumps the IN-MEMORY generation
   * counter — that alone changes nothing ON DISK until something calls refreshGateSidecar(). Four
   * call sites wrote noteRuleTouched but never that follow-up call: detach()'s partial-detach
   * (source-survives) branch, resolveContradiction's explicit-body-override branch, applySynthesis
   * (the agent-facing MCP twin), and synthesizeRow's own two callers (getConcept's lazy synthesis,
   * checkpoint's batch). Each is proven directly below: a configured sidecar path, the retitling
   * act, then reading the FILE ON DISK (not sidecarGeneration(), which only proves the IN-MEMORY
   * counter moved) for the recomputed title, with no intervening unrelated mutation.
   */
  it("detach()'s partial-detach branch refreshes the on-disk mirror immediately — the recomputed source title lands without an unrelated write (Codex round 6, item 1)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, syncDeviceId: "machine-a" });
    const rule = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo",
      scope: "domain",
    });
    if (rule.species !== "rule") throw new Error("unreachable");
    // A second observation on the SAME concept, so a PARTIAL detach (source survives) is reachable —
    // detaching the first leaves the second as the source's sole remaining, recomputed-title evidence.
    await c.store("Confirm the target path is not a mount point.", { attachTo: rule.conceptId });
    const before = read(path);
    expect(before.entries[0]!.text).not.toContain("Confirm the target path");

    const firstObsId = (await c.getConcept(rule.conceptId))!.observations[0]!.id;
    await c.detach(rule.conceptId, [firstObsId]);

    // ON DISK, IMMEDIATELY — no unrelated mutation, no explicit materializeGateMirror() call.
    const after = read(path);
    expect(after.entries).toHaveLength(1); // still the same one live rule, just retitled
    expect(after.entries[0]!.text).toContain("Confirm the target path");
    expect(c.isSidecarStale().stale).toBe(false);
    c.close();
  });

  it("closes the same family for applySynthesis, resolveContradiction's explicit-body-override, and both synthesizeRow callers (getConcept's lazy synthesis, checkpoint's batch) — each refreshes the on-disk mirror immediately (Codex round 6, item 1)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, syncDeviceId: "machine-a" });

    // applySynthesis: the agent-facing MCP twin of synthesizeRow's own retitling.
    const forSynthesis = await c.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Prefer npm ci over npm install.", severity: "advisory", scope: "domain",
    });
    if (forSynthesis.species !== "rule") throw new Error("unreachable");
    await c.applySynthesis(forSynthesis.conceptId, "Always run npm ci in CI, never npm install.");
    expect(read(path).entries.find((e) => e.conceptId === forSynthesis.conceptId)?.text)
      .toContain("Always run npm ci in CI");
    expect(c.isSidecarStale().stale).toBe(false);

    // resolveContradiction: an explicit body override on the accept-new/keep-current verdict.
    // "A rule is corrected, never mediated" (door 7's own comment, this file) refuses an open
    // contradiction against a rule concept at EVERY documented entrance — local flagContradiction
    // outright, and a relayed one too, unconditionally, regardless of severity. resolveContradiction
    // itself carries no such guard (it operates on whatever open contradiction it is handed), so this
    // is reachable only the way the codebase's own other defensive checks already assume things can
    // arrive: a row that bypassed every guard (a hand-edited store, an older build predating door 7).
    // Inserted directly, matching that convention, to prove resolveContradiction's OWN behavior on
    // the row it is handed rather than relitigating how a contradiction could end up on a rule.
    const forContradiction = await c.declare({
      species: "rule", stage: "git push --force", patterns: ["Bash:git push --force"],
      content: "Never force-push to a shared branch.", severity: "advisory", scope: "domain",
    });
    if (forContradiction.species !== "rule") throw new Error("unreachable");
    const contradictionId = "bypassed-guard-contradiction-1";
    raw(c).prepare(
      `INSERT INTO contradictions (id, concept_id, kind, status, detail, detected_at, updated_at, sync_revision, sync_writer)
       VALUES (?, ?, 'value-conflict', 'open', 'a peer disagrees', ?, ?, 0, 'x')`,
    ).run(contradictionId, forContradiction.conceptId, Date.now(), Date.now());
    c.resolveContradiction(contradictionId, { decision: "accept-new", body: "Force-push only with --force-with-lease, and only to your own branch." });
    expect(read(path).entries.find((e) => e.conceptId === forContradiction.conceptId)?.text)
      .toContain("Force-push only with --force-with-lease");
    expect(c.isSidecarStale().stale).toBe(false);

    // getConcept's lazy synthesis: a fetch that happens to be the trigger for pending synthesis.
    const forLazySynthesis = await c.declare({
      species: "rule", stage: "terraform apply", patterns: ["terraform apply"],
      content: "Never apply without a plan review.", severity: "advisory", scope: "domain",
    });
    if (forLazySynthesis.species !== "rule") throw new Error("unreachable");
    await c.store("Always run terraform plan and share the diff before applying.", { attachTo: forLazySynthesis.conceptId });
    raw(c).prepare(`UPDATE concepts SET dirty = 1 WHERE id = ?`).run(forLazySynthesis.conceptId); // force the lazy path
    await c.getConcept(forLazySynthesis.conceptId, { synthesize: true });
    expect(c.isSidecarStale().stale).toBe(false);

    // checkpoint's batch: the same synthesizeRow, reached through the multi-concept path.
    const forCheckpoint = await c.declare({
      species: "rule", stage: "docker system prune", patterns: ["Bash:docker system prune"],
      content: "Never prune without confirming with the team.", severity: "advisory", scope: "domain",
    });
    if (forCheckpoint.species !== "rule") throw new Error("unreachable");
    await c.store("Post in #ops before pruning, every time.", { attachTo: forCheckpoint.conceptId });
    raw(c).prepare(`UPDATE concepts SET dirty = 1 WHERE id = ?`).run(forCheckpoint.conceptId);
    await c.checkpoint();
    expect(c.isSidecarStale().stale).toBe(false);

    c.close();
  });

  it("bumps on a circle rename that moves a deny, and on a supersession that ends one", async () => {
    const c = core({ circle: "proj" });
    const deny = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    const before = c.sidecarGeneration();
    c.renameCircle("proj", "project-renamed");
    // +2, not +1, as of Codex round 11, item 3: trg_rule_bindings_follow_concept_circle's own
    // unconditional bump for the moved concept (unchanged — this rename carries a live deny) PLUS
    // trg_circle_aliases_bump_on_insert firing for the from→to alias row this rename also publishes
    // (gates.ts, migrateGateColumns) — circle_aliases writes were not mirror-bump-covered by any
    // mechanism at all before this round (see that trigger family's own comment for why: circle
    // aliases only became mirror content in format 4, and no build predates knowing to bump for it
    // deliberately; renameCircle's own gated JS bump happened to be silent here too, because the
    // rule_bindings trigger had already advanced the generation before the gate was checked — see
    // renameCircle's own comment, engine.ts, for the removed call this replaces).
    expect(c.sidecarGeneration()).toBe(before + 2);
    // The mirror names each rule's circle, so the rename really did change the file's content.
    expect(c.materializeGateMirror(join(mkTmp(), "s.json")).sidecar.entries[0]!.circle).toBe("project-renamed");

    const successor = await c.store("A replacement rule.", {
      circle: "project-renamed", kind: "rule", rule: { stage: "rm -rf", ...AGENT_RULE },
    });
    // Superseding a LIVE deny is refused (door 11); withdraw it first, which is itself a bump.
    expect(() => c.addLifecycleEdge({
      family: "supersession", srcConceptId: deny.conceptId, dstConceptId: successor.conceptId, bornOf: "declaration",
    })).toThrow(/would remove the blocking rule/);
    await withdrawDeny(c, deny.conceptId, "rm -rf", "project-renamed");
    const beforeSupersede = c.sidecarGeneration();
    c.addLifecycleEdge({
      family: "supersession", srcConceptId: deny.conceptId, dstConceptId: successor.conceptId, bornOf: "declaration",
    });
    // A FURTHER bump, where format 4 disagrees with format 3: the withdrawn rule is ADVISORY, not
    // gone — it stayed in `entries` (both severities are mirror content now) right up until THIS
    // supersession edge excludes it (the `NOT EXISTS supersession` clause every liveness check
    // shares). "The rule left the mirror at the withdrawal" was true only while the mirror was
    // blocking-only; here it leaves at the supersession, and that is what must bump.
    expect(c.sidecarGeneration()).toBe(beforeSupersede + 1);
    c.close();
  });

  it("stamps the generation into the file and answers isSidecarStale truthfully", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });

    // Opening the store with a path configured LEAVES A USABLE MIRROR, before any rule exists. An
    // empty entries array is the correct mirror of a store with nothing blocking, and is what makes
    // the hook's "no file at all" case mean what it says.
    expect(c.isSidecarStale()).toEqual({ stale: false, generation: c.sidecarGeneration() });
    expect(read(path).entries).toEqual([]);

    // MISSING is stale — the hook's question is "can I trust this to decide a deny", and for a file
    // that is not there the answer is no. Removed by hand now that construction no longer leaves the
    // path empty; the contract it pins is unchanged.
    rmSync(path);
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "missing", fileGeneration: null });

    const deny = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    expect(read(path).generation).toBe(c.sidecarGeneration());
    expect(c.isSidecarStale()).toEqual({ stale: false, generation: c.sidecarGeneration() });

    // BEHIND — the file's own header is what makes this detectable at all. `checksum` STRIPPED here
    // (Codex round 12, item 1), not merely carried over: this test hand-mutates ONE field
    // (`generation`) while keeping the rest, and a checksum copied verbatim from the pre-mutation
    // read would now mismatch the mutated content — genuinely malformed, not merely behind, exactly
    // the corruption detection the checksum exists to provide. Stripping it keeps this test isolated
    // to the generation-comparison logic it actually targets (verify-if-present: an absent checksum
    // skips verification entirely, the same dev-window path a pre-checksum v4 file takes).
    const { checksum: _staleChecksum, ...stale } = read(path);
    writeFileSync(path, JSON.stringify({ ...stale, generation: stale.generation - 1 }), "utf8");
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "behind", fileGeneration: stale.generation - 1 });

    // UNREADABLE is stale, not an exception on the critical path of somebody's action.
    // MALFORMED covers both "not JSON" and "JSON of the wrong shape" — parsing successfully says
    // nothing about structure, and reading fields off `null` or `[]` would throw on the critical
    // path of an action, which the never-throw contract forbids.
    writeFileSync(path, "{ not json", "utf8");
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "malformed" });
    writeFileSync(path, JSON.stringify({ entries: [] }), "utf8");
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "malformed" });
    for (const junk of ["null", "[]", '"a string"', "42", JSON.stringify({ generation: "seven", entries: [] }), JSON.stringify({ generation: 1 })]) {
      writeFileSync(path, junk, "utf8");
      expect(c.isSidecarStale(), junk).toMatchObject({ stale: true, reason: "malformed" });
    }

    // A file from ANOTHER store is not this store's mirror either, even if its count runs ahead.
    writeFileSync(path, JSON.stringify({ ...stale, generation: stale.generation + 99 }), "utf8");
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "behind" });
    c.close();
  });

  /**
   * THE FORMAT BUMP HAS TO REACH DISK, or it is worse than not bumping at all.
   *
   * A version number that a reader honours and a writer ignores is how "defensive" turns into an
   * outage: the hook rejects a shape it cannot parse — correctly — while nothing on the writing side
   * ever replaces the file, so offline blocking is simply gone until an unrelated mutation happens
   * to move the generation counter. The generation compare was right about vintage and wrong to be
   * the only comparison.
   */
  const withDeny = async (path: string) => {
    const c = new MonetCore(":memory:", {
      tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, syncDeviceId: "machine-a",
    });
    await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    return c;
  };

  it("calls a mirror of the WRONG SHAPE stale, however current its generation and identity look", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    expect(c.isSidecarStale().stale).toBe(false);

    // The upgraded install, exactly: same store, same generation, previous entry shape. Every check
    // that existed before this one passes — which is what made the failure quiet.
    const current = read(path);
    writeFileSync(path, JSON.stringify({ ...current, format: 3 }), "utf8");
    expect(c.isSidecarStale()).toMatchObject({
      stale: true, reason: "format", fileFormat: 3, format: 4, fileGeneration: current.generation,
    });

    // A v1 file predates the field entirely. Not ours either, and it says so with fileFormat null
    // rather than by being lumped in with unparseable junk.
    const { format: _dropped, ...noFormat } = current;
    writeFileSync(path, JSON.stringify(noFormat), "utf8");
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "format", fileFormat: null });
    c.close();
  });

  /**
   * A FRACTIONAL FORMAT IS MALFORMED, NOT A FUTURE FORMAT TO DEFER TO. Format versions are discrete —
   * there is no meaning between format 4 and format 5 — so `4.5` is not "a number ahead of ours",
   * it is a corrupt header. Before this fix it classified exactly like a genuine future build's file:
   * `format-ahead` here, and `skipped-format-ahead` forever from materializeGateMirror, preserved
   * on the promise of an upgrade that would never arrive, since no build — past or future — will ever
   * actually write format 4.5. Same permanent-strand shape as the round-9 generation finding, one
   * field over.
   */
  it("treats a FRACTIONAL format as malformed, not as a future format to defer to", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const current = read(path);

    const fractional = { ...current, format: 4.5 };
    writeFileSync(path, JSON.stringify(fractional), "utf8");
    // NOT format-ahead: the whole header is rejected at the read seam, so this is indistinguishable
    // from any other structurally-wrong file — same reason, same fileGeneration: null.
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "malformed", fileGeneration: null });

    const result = c.materializeGateMirror();
    expect(result.outcome).toBe("written"); // regenerated, not preserved as an unreadable "future" shape
    expect(read(path).format).toBe(4);
    expect(read(path).entries).toHaveLength(1);
    expect(c.isSidecarStale().stale).toBe(false);
    c.close();
  });

  /**
   * FORMAT 4 REQUIRES stages/circleAliases TOO (Codex round 1, item 2). readSidecarHeader checked
   * `entries` but not the two arrays format 4 also added, so `{format:4, generation:n, entries:[]}`
   * — every earlier check passing (a valid generation, entries genuinely an array, format genuinely
   * an integer) — read as an ordinary CURRENT v4 file with two empty sections. It is not: it is
   * structurally wrong, and reading `mirror.stages` off it throws (proven directly below) the first
   * time anything iterates it — the read-path-throw class this fix closes at the ONE chokepoint both
   * consumers share.
   */
  it("treats a format-4 header missing stages/circleAliases as malformed, not as an empty-but-current v4 file (Codex round 1, item 2)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const current = read(path) as unknown as Record<string, unknown>;

    // The exact shape Codex named: format matches, generation matches, entries is genuinely `[]` —
    // stages and circleAliases simply never made it into this file at all.
    const { stages: _stages, circleAliases: _circleAliases, ...missingBoth } = current;
    writeFileSync(path, JSON.stringify({ ...missingBoth, entries: [] }), "utf8");
    // BOTH SURFACES MUST AGREE. inspectSidecar says malformed —
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "malformed", fileGeneration: null });
    // — and materializeGateMirror regenerates rather than skipping "an already-current file" (the
    // generation in the malformed header equals the store's own).
    const result = c.materializeGateMirror();
    expect(result.outcome).toBe("written");
    expect(read(path).entries).toHaveLength(1);
    expect(read(path).stages.length).toBeGreaterThan(0);
    expect(read(path).circleAliases).toEqual([]);
    expect(c.isSidecarStale().stale).toBe(false);

    // Proven directly, not merely inferred: the shape this fix rejects would have crashed
    // evaluateGateFromMirror on the read path this whole header check exists to keep off of — here,
    // at `mirror.circleAliases.find(...)` (the M3 alias-resolution fix runs before the stages loop
    // even starts); with only `stages` missing it throws one step later, iterating `mirror.stages`
    // ("not iterable"). Either way: a TypeError on a read, not a graceful answer.
    const malformed = { ...missingBoth, entries: [] } as unknown as GateMirror;
    expect(() => evaluateGateFromMirror(malformed, { actionContext: "Bash:rm -rf /tmp/x", circle: "default" }))
      .toThrow(TypeError);
    c.close();
  });

  it("treats stages: 'not-an-array' as malformed too, at format 4 (Codex round 1, item 2)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const current = read(path);

    writeFileSync(path, JSON.stringify({ ...current, stages: "not-an-array" }), "utf8");
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "malformed", fileGeneration: null });
    const result = c.materializeGateMirror();
    expect(result.outcome).toBe("written");
    expect(Array.isArray(read(path).stages)).toBe(true);
    expect(c.isSidecarStale().stale).toBe(false);
    c.close();
  });

  /**
   * ARRAY-NESS ALONE IS NOT ELEMENT SHAPE (Codex round 5, item 1, read-path-crash class).
   * `Array.isArray(header.entries)` passed `entries: [null]` clean through — the array genuinely IS
   * an array — and the crash lands one layer down, on the FIRST read of any element:
   * `evaluateGateFromMirror`'s own filter dereferences `entry.stageId` unconditionally
   * (`matchedStageIds.has(entry.stageId)`), so `entry === null` throws "Cannot read properties of
   * null" before the filter's own logic ever runs — the same shape one layer over for
   * `stage.triggerPatterns` and `row.from` (circleAliases). Proven directly against
   * `evaluateGateFromMirror` itself below, not merely inferred from `isSidecarStale`'s own verdict —
   * matching the precedent the format-4-missing-arrays test above already set.
   */
  it("treats [null] as a malformed element in entries, stages, AND circleAliases — not merely a malformed array (Codex round 5, item 1)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const current = read(path) as unknown as Record<string, unknown>;

    for (const field of ["entries", "stages", "circleAliases"] as const) {
      const corrupted = { ...current, [field]: [null] };
      writeFileSync(path, JSON.stringify(corrupted), "utf8");
      expect(c.isSidecarStale(), field).toMatchObject({ stale: true, reason: "malformed", fileGeneration: null });
      const result = c.materializeGateMirror();
      expect(result.outcome, field).toBe("written"); // regenerated, not preserved as "already current"
      // Regenerated to a genuine array with the corrupt [null] gone — NOT asserting a specific
      // length here: circleAliases is legitimately EMPTY in this fixture (withDeny never renames a
      // circle), while entries/stages each carry exactly the one real rule/stage. What every field
      // shares is "no longer contains the corruption".
      expect(Array.isArray(read(path)[field]), field).toBe(true);
      expect(read(path)[field], field).not.toContain(null);
      expect(c.isSidecarStale().stale, field).toBe(false);

      // Proven directly: the shape this fix rejects would have crashed evaluateGateFromMirror on
      // the read path this whole header check exists to keep off of.
      expect(() => evaluateGateFromMirror(corrupted as unknown as GateMirror, { actionContext: "Bash:rm -rf /tmp/x", circle: "default" }))
        .toThrow(TypeError);
    }
    c.close();
  });

  it("treats an entry missing stageId as malformed, at format 4 (Codex round 5, item 1)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const current = read(path) as unknown as Record<string, unknown>;
    const entries = current.entries as Array<Record<string, unknown>>;

    const { stageId: _stageId, ...entryMissingStageId } = entries[0]!;
    const corrupted = { ...current, entries: [entryMissingStageId] };
    writeFileSync(path, JSON.stringify(corrupted), "utf8");
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "malformed", fileGeneration: null });
    const result = c.materializeGateMirror();
    expect(result.outcome).toBe("written");
    expect(read(path).entries).toHaveLength(1);
    expect((read(path).entries[0] as unknown as Record<string, unknown>).stageId).toBeDefined();
    expect(c.isSidecarStale().stale).toBe(false);
    c.close();
  });

  it("treats a stage with triggerPatterns of the wrong type (not a string) as malformed, at format 4 (Codex round 5, item 1)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const current = read(path) as unknown as Record<string, unknown>;
    const stages = current.stages as Array<Record<string, unknown>>;

    // A NUMBER, not a string — `parseTriggerPatterns`'s own declared parameter type is `string`, and
    // JSON.parse's implicit ToString coercion means this would not itself crash the parser (it
    // silently yields zero patterns instead) — but that stage would go permanently, silently quiet,
    // an offline/live parity gap the malformed classification exists to prevent, not only crashes.
    const corrupted = { ...current, stages: [{ ...stages[0], triggerPatterns: 42 }] };
    writeFileSync(path, JSON.stringify(corrupted), "utf8");
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "malformed", fileGeneration: null });
    const result = c.materializeGateMirror();
    expect(result.outcome).toBe("written");
    expect(typeof (read(path).stages[0] as unknown as Record<string, unknown>).triggerPatterns).toBe("string");
    expect(c.isSidecarStale().stale).toBe(false);
    c.close();
  });

  /**
   * VALUE, NOT JUST SHAPE (Codex round 9, item 4 — a PR finding: an unrecognized severity "can
   * similarly make a cached deny appear non-blocking to consumers"). `entry.severity === "blocking"`
   * does not crash on a garbage string — it silently answers false, exactly the failure mode a mere
   * `typeof === "string"` shape check (round 5) cannot catch, since a typo'd severity is still a
   * string.
   */
  it("treats an entry with an unrecognized severity value as malformed, at format 4 (Codex round 9, item 4)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const current = read(path) as unknown as Record<string, unknown>;
    const entries = current.entries as Array<Record<string, unknown>>;

    // A STRING, so round 5's own `typeof === "string"` shape check alone would have passed this
    // clean through — the exact gap this item closes: "critical" is well-typed, just not one of
    // RULE_SEVERITIES, and the live evaluator's own `severity === "blocking"` branch would have
    // silently treated it as non-blocking, not thrown.
    const corrupted = { ...current, entries: [{ ...entries[0], severity: "critical" }] };
    writeFileSync(path, JSON.stringify(corrupted), "utf8");
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "malformed", fileGeneration: null });
    const result = c.materializeGateMirror();
    expect(result.outcome).toBe("written");
    expect(read(path).entries).toHaveLength(1);
    expect(read(path).entries[0]!.severity).toBe("blocking"); // regenerated from the store, not the corrupt value
    expect(c.isSidecarStale().stale).toBe(false);
    c.close();
  });

  /**
   * VALUE, NOT JUST SHAPE, THE SCOPE HALF (Codex round 9, item 4 — the PR finding's own worked
   * example): "removing scope from an agent-scoped entry leaves the same-generation file classified
   * as current, and `ruleTagIsLive(undefined, ...)` then treats that rule as domain-scoped and fires
   * it for the wrong runtime model". `scope` was PREVIOUSLY not checked at all by
   * `hasMirrorEntryShape` (round 5 deliberately excluded it, reasoning it could not crash) — this is
   * the first shape/value check this field has ever had.
   */
  it("treats an entry with a missing or unrecognized scope value as malformed, at format 4 (Codex round 9, item 4)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const current = read(path) as unknown as Record<string, unknown>;
    const entries = current.entries as Array<Record<string, unknown>>;

    for (const badScope of [undefined, "unrecognized-scope"] as const) {
      const withOrWithoutScope: Record<string, unknown> = { ...entries[0] };
      if (badScope === undefined) delete withOrWithoutScope.scope;
      else withOrWithoutScope.scope = badScope;
      const corrupted = { ...current, entries: [withOrWithoutScope] };
      writeFileSync(path, JSON.stringify(corrupted), "utf8");
      expect(c.isSidecarStale(), String(badScope)).toMatchObject({ stale: true, reason: "malformed", fileGeneration: null });
      const result = c.materializeGateMirror();
      expect(result.outcome, String(badScope)).toBe("written");
      expect(read(path).entries, String(badScope)).toHaveLength(1);
      expect(c.isSidecarStale().stale, String(badScope)).toBe(false);
    }
    c.close();
  });

  /**
   * REFERENTIAL, NOT JUST PER-ELEMENT SHAPE (Codex round 11, item 5). Every check above validates
   * ONE array's elements in isolation — entries individually well-shaped, stages individually
   * well-shaped — but never asks whether the two arrays actually agree with each other.
   * `GateMirrorEntry.stageId`'s own comment says plainly: "join against `GateMirror.stages` to match
   * and to render" — an entry naming a stageId absent from this SAME file's own `stages[]` can never
   * be reached through that join, live or offline.
   */
  it("treats an entry whose stageId names no stage in the same mirror as malformed, at format 4 (Codex round 11, item 5)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const current = read(path) as unknown as Record<string, unknown>;
    const entries = current.entries as Array<Record<string, unknown>>;

    // A well-shaped entry — a real string stageId, so hasMirrorEntryShape alone passes it clean
    // through — that simply names a stage absent from THIS file's own stages[]. HOLDS BY
    // CONSTRUCTION for any file this build honestly writes (listGateMirrorEntries' own INNER JOIN to
    // stages), so this can only arise from a hand-edited or corrupted file — exactly what this
    // function exists to refuse.
    const corrupted = { ...current, entries: [{ ...entries[0], stageId: "no-such-stage-in-this-file" }] };
    writeFileSync(path, JSON.stringify(corrupted), "utf8");
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "malformed", fileGeneration: null });
    const result = c.materializeGateMirror();
    expect(result.outcome).toBe("written");
    expect(read(path).entries).toHaveLength(1);
    // Regenerated from the store, not the corrupt value — the real stageId names a real stage again.
    expect(read(path).entries[0]!.stageId).not.toBe("no-such-stage-in-this-file");
    expect(read(path).stages.some((s) => s.id === read(path).entries[0]!.stageId)).toBe(true);
    expect(c.isSidecarStale().stale).toBe(false);
    c.close();
  });

  /**
   * THE CONTENT CHECKSUM (Codex round 12, item 1 — closes the validation-depth category, John's own
   * ratification 2026-07-28). Four tests: a plain round-trip, the corruption case the checksum exists
   * for that no shape check could ever catch, the dev-window backward-compatibility case, and
   * confirmation that adding a NEW field to the header did not disturb the EXISTING compare-before-
   * replace machinery that reads the header for a completely different reason.
   */
  it("round-trips: materializeGateMirror writes a checksum, and the same file reads back as current", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const written = read(path);
    // ADDITIVE, present on every file this build writes — a string, not merely truthy, and 64 hex
    // characters (sha256's own digest length in hex).
    expect(written.checksum).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(c.isSidecarStale()).toEqual({ stale: false, generation: c.sidecarGeneration() });
    c.close();
  });

  it("a single-byte corruption inside an otherwise well-typed, well-shaped string is caught as malformed — the gap no shape check could ever close — and materializeGateMirror regenerates it (Codex round 12, item 1)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const before = read(path);
    expect(before.entries[0]).toMatchObject({ reason: "there is no undo" });

    // ONE CHARACTER, inside the `reason` string — still perfectly valid JSON (no structural
    // character touched), still a STRING where a string is expected (every existing shape check
    // passes this clean through, exactly as it would before this item existed), and still silently
    // WRONG: the store's own reason is "there is no undo", the file now claims "Xhere is no undo".
    // No `hasMirrorEntryShape`-style check can ever catch this — a corrupted string is still a
    // string — which is precisely the depth the checksum exists to add.
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("there is no undo");
    writeFileSync(path, raw.replace("there is no undo", "Xhere is no undo"), "utf8");

    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "malformed", fileGeneration: null });
    const result = c.materializeGateMirror();
    expect(result.outcome).toBe("written");
    // REGENERATED from the store, not the corrupted value — and the fresh file's own checksum now
    // verifies against ITS content (not asserted equal to `before.checksum`: `generatedAt` is a live
    // timestamp with no `now` override reachable through this public method, so two materializations
    // legitimately produce two different canonical strings, and two different checksums, even over
    // otherwise-identical content — exactly as the recipe's own inclusion of every field intends).
    expect(read(path).entries[0]).toMatchObject({ reason: "there is no undo" });
    expect(c.isSidecarStale().stale).toBe(false);
    c.close();
  });

  it("a checksum-less v4 file (the dev-window case — a file predating this field) still reads as current (Codex round 12, item 1)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const withChecksum = read(path) as unknown as Record<string, unknown>;
    expect(withChecksum.checksum).toBeDefined();

    // SIMULATE a pre-checksum v4 file: every field this build already wrote, `checksum` simply never
    // added at all — not `checksum: undefined` (which JSON.stringify would already drop on its own),
    // genuinely absent, the same shape a file from before this item shipped has.
    const { checksum: _omitted, ...withoutChecksum } = withChecksum;
    expect(Object.keys(withoutChecksum)).not.toContain("checksum");
    writeFileSync(path, JSON.stringify(withoutChecksum), "utf8");

    // VERIFY-IF-PRESENT: absent here, so verification is skipped entirely — the file reads exactly
    // as it always would have before this item existed, on the shape checks alone.
    expect(c.isSidecarStale()).toEqual({ stale: false, generation: c.sidecarGeneration() });
    c.close();
  });

  it("the checksum survives the compare-before-replace path — skipped-current still recognizes an up-to-date checksummed file, and a corrupted one is overwritten rather than skipped (Codex round 12, item 1)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const firstWrite = read(path);
    expect(firstWrite.checksum).toBeDefined();

    // NOTHING CHANGED about the store — materializing again must recognize the EXISTING, checksummed
    // file as already current and decline to rewrite it. This is the exact path
    // materializeGateMirror's own comment calls "COMPARE BEFORE REPLACE": readSidecarHeader is called
    // on the file BEFORE any decision to write, and that function is where checksum verification
    // lives — confirming the addition of a new field to the header did not disturb the skip logic,
    // which reads generation/storeIdentity/format from that SAME return value and has no notion of
    // `checksum` of its own.
    const repeat = c.materializeGateMirror();
    expect(repeat.outcome).toBe("skipped-current");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(firstWrite); // untouched, byte for byte
    expect(c.isSidecarStale()).toEqual({ stale: false, generation: c.sidecarGeneration() });

    // A CORRUPTED existing file must NOT be recognized as "already current" and skipped — it reads
    // as if it were not there at all (readSidecarHeader returns null), so the compare-before-replace
    // logic falls through every skip branch and proceeds to overwrite it, exactly like any other
    // malformed file.
    const raw = readFileSync(path, "utf8");
    writeFileSync(path, raw.replace("there is no undo", "Xhere is no undo"), "utf8");
    const afterCorruption = c.materializeGateMirror();
    expect(afterCorruption.outcome).toBe("written");
    expect(read(path)).toMatchObject({ entries: [expect.objectContaining({ reason: "there is no undo" })] });
    expect(c.isSidecarStale().stale).toBe(false);
    c.close();
  });

  /**
   * THE v4-ARRAY REQUIREMENT MUST NOT SWALLOW THE FUTURE (review fix — Codex round 2, item 5; round
   * 1's own fix, above, is what this bounds). `format >= 4` with no upper bound applied the "must
   * have stages/circleAliases as arrays" requirement to ANY format at or past 4 — including one this
   * build has never heard of. A legitimate same-store v5 file that legitimately restructured those
   * fields would fail that shape check exactly like a truly corrupt file: `malformed`, not
   * `format-ahead` — and materializeGateMirror would then OVERWRITE it, which is precisely the
   * thrash the format-ahead machinery exists to prevent (see its own "REFUSES to overwrite..." test
   * above), broken by the very guard meant to strengthen it.
   */
  it("treats a format AHEAD of this build as format-ahead, not malformed — even with missing or restructured v4 arrays (Codex round 2, item 5)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const current = read(path) as unknown as Record<string, unknown>;

    // A legitimate future build's file: format ahead of what THIS build understands, and its own
    // (here, deliberately incompatible) shape for whatever format 4 called stages/circleAliases —
    // this build cannot know whether that is "restructured" or "missing", and must not guess.
    const futureFormat = (current.format as number) + 1;
    const fromTheFuture = {
      ...current, format: futureFormat, stages: { restructured: true }, circleAliases: "not even an array",
    };
    writeFileSync(path, JSON.stringify(fromTheFuture), "utf8");
    expect(c.isSidecarStale()).toMatchObject({
      stale: true, reason: "format-ahead", fileFormat: futureFormat, format: GATE_MIRROR_FORMAT,
    });

    c.materializeGateMirror();
    // UNTOUCHED, byte for byte — the format-ahead contract, unbroken by the array requirement.
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(fromTheFuture);
    c.close();
  });

  it("REWRITES a stale-shaped mirror even though the generation has not moved", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const current = read(path);

    // Downgrade the file in place and change nothing else. Before format joined the replace
    // decision, the skip-if-not-newer guard fired here and the v3 artifact survived indefinitely.
    writeFileSync(path, JSON.stringify({ ...current, format: 3 }), "utf8");
    expect(c.sidecarGeneration()).toBe(current.generation); // nothing about the store has changed

    c.materializeGateMirror();
    expect(read(path).format).toBe(4);
    expect(read(path).entries[0]).toMatchObject({ reason: "there is no undo" });
    expect(c.isSidecarStale().stale).toBe(false);
    c.close();
  });

  it("REFUSES to overwrite a mirror written by a build AHEAD of this one, and names the skew", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const current = read(path);

    // A format we do not speak, from a writer we cannot second-guess. Declining is not about losing
    // data — the mirror is derived and either build can regenerate it — it is about THRASH: if an
    // older build clobbered forward-format files, two installs sharing a path would each overwrite
    // the other on every invocation and both hooks would fail unreproducibly. Declining makes the
    // failure deterministic and attributable to the install that needs upgrading.
    const fromTheFuture = { ...current, format: 99, entries: [{ somethingWeCannotRead: true }] };
    writeFileSync(path, JSON.stringify(fromTheFuture), "utf8");

    c.materializeGateMirror();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(fromTheFuture); // untouched, byte for byte

    // ...and NOT a silent no-op: the operator asking gets the direction of the skew, not just "bad".
    expect(c.isSidecarStale()).toMatchObject({
      stale: true, reason: "format-ahead", fileFormat: 99, format: 4,
    });
    c.close();
  });

  it("OVERWRITES a forward-format mirror that belongs to a different store", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const current = read(path);

    // Same unreadable future format as above — but somebody else's. The thrash argument needs two
    // installs sharing a path for the SAME store; a foreign file is not the other half of a thrash
    // pair, it is debris a restore left in our directory. Deferring to it would defer to a file we
    // have already decided we cannot read, and the skip repeats forever — so this store would never
    // get an offline deny at all, which is the failure the mirror exists to prevent.
    const somebodyElses = {
      ...current, format: 99, storeIdentity: "a-different-store-entirely",
      entries: [{ somethingWeCannotRead: true }],
    };
    writeFileSync(path, JSON.stringify(somebodyElses), "utf8");

    c.materializeGateMirror();

    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.format).toBe(4);
    expect(after.storeIdentity).toBe(current.storeIdentity);
    expect(after.entries).toHaveLength(1); // our deny, back on disk
    expect(c.isSidecarStale()).toMatchObject({ stale: false });
    c.close();
  });

  /**
   * OPENING THE STORE IS THE REPAIR TRIGGER, because an upgrade is the one event that invalidates
   * the mirror without touching the store. Every other refresh site is a MUTATION site, so
   * detection alone left the hook rejecting a file that nothing regenerated: offline blocking
   * unavailable until some unrelated gate-affecting write happened to occur.
   */
  it("REGENERATES a wrong-shaped mirror when the store is merely OPENED, with no write at all", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const first = await withDeny(path);
    const current = read(path);
    first.close();

    // The upgrade, exactly: the file on disk is the previous shape, and nothing about the store has
    // changed or is about to. Before this, the next reader was a v4 build rejecting a v3 file.
    writeFileSync(path, JSON.stringify({ ...current, format: 3 }), "utf8");

    const reopened = new MonetCore(":memory:", {
      tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, syncDeviceId: "machine-a",
    });
    // NOT a declaration, NOT a gate, NOT a graft — the constructor returning is the whole event.
    expect(read(path).format).toBe(4);
    expect(reopened.isSidecarStale().stale).toBe(false);
    reopened.close();
  });

  /**
   * A WRITER THAT SAYS IT WROTE WHEN IT DID NOT is the same lie this module spends its length
   * preventing everywhere else. materializeGateMirror returned the freshly generated,
   * current-format sidecar whatever happened — so a DECLINED write was indistinguishable from a
   * successful one, and install or recovery tooling reported "mirror regenerated" over a file its
   * own hook rejects. The artifact it hands back is what it GENERATED; the outcome is what reached
   * disk, and only the caller can be trusted to know the difference matters.
   */
  it("reports skipped-format-ahead rather than claiming it wrote the mirror it declined", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const current = read(path);
    const fromTheFuture = { ...current, format: 99, entries: [{ somethingWeCannotRead: true }] };
    writeFileSync(path, JSON.stringify(fromTheFuture), "utf8");

    const result = c.materializeGateMirror();
    expect(result.outcome).toBe("skipped-format-ahead");
    // The generated mirror is still handed back — it is what WOULD have been written, and reading
    // it is legitimate. What is no longer possible is mistaking it for the file on disk.
    expect(result.sidecar.format).toBe(4);
    expect(result.sidecar.entries).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(fromTheFuture);
    // The two agree, which is the property that makes either one safe to act on.
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "format-ahead" });
    c.close();
  });

  it("distinguishes a genuine no-op from a declined write, because they are not the same news", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);

    // Nothing has changed since the declaration auto-refreshed the file, so it already says what we
    // would say. The mirror is FINE — this is the one skip a caller may treat as success, and the
    // reason the two skips needed separate names rather than a single boolean.
    const noop = c.materializeGateMirror();
    expect(noop.outcome).toBe("skipped-current");
    expect(c.isSidecarStale().stale).toBe(false);

    // Recovery after the file is lost — the other documented reason this method is public. Here the
    // write really happens, and "written" is what entitles the caller to report a repaired mirror.
    rmSync(path);
    const written = c.materializeGateMirror();
    expect(written.outcome).toBe("written");
    expect(written.sidecar.entries).toHaveLength(1);
    expect(read(path).entries).toHaveLength(1);
    expect(c.isSidecarStale().stale).toBe(false);
    c.close();
  });

  /**
   * AHEAD OF OUR SNAPSHOT IS AMBIGUOUS ON ITS OWN — rollback debris and a legitimate racing writer
   * produce the identical shape (same store, same format, `existing.generation > sidecar.generation`)
   * and only a fresh read of the store's CURRENT generation tells them apart. See
   * materializeGateMirror's own comment for the full split. This pins the ROLLBACK half: no
   * concurrent writer exists in this test, so the fabricated file is ahead of the store's CURRENT
   * generation too, not merely ahead of what this call snapshotted — the only shape that is genuinely
   * debris of an abandoned lineage. Before this fix, `existing.generation >= sidecar.generation`
   * treated EVERY ahead file this way, race included: refresh became a permanent no-op, and explicit
   * recovery reported `skipped-current` for a mirror that was, in truth, still serving an abandoned
   * deny set. The RACE half is pinned by the sibling test below.
   */
  it("OVERWRITES a same-store, same-format mirror whose generation is ahead of the store's CURRENT generation (rollback, not a race)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const current = read(path);

    // Same store, same format — only the generation is wrong, and wrong in the direction that used
    // to earn deference. Entries are wiped too, so a wrongly-preserved file would be caught either
    // way: by the generation number staying too high, or by the deny silently disappearing.
    const fromABackward = { ...current, generation: current.generation + 7, entries: [] };
    writeFileSync(path, JSON.stringify(fromABackward), "utf8");
    // PINS "ahead of CURRENT", not just "ahead of the old snapshot": nothing mutates the store between
    // this line and the call below, so the store's live generation is still exactly `current.generation`
    // — the fabricated file is ahead of THAT, which is what makes it rollback debris rather than a race.
    expect(c.sidecarGeneration()).toBe(current.generation);

    const result = c.materializeGateMirror();
    expect(result.outcome).toBe("written");
    expect(read(path).generation).toBe(current.generation); // the store's own count, not the stale-ahead one
    expect(read(path).entries).toHaveLength(1); // the store's real deny is back, not the fabricated empty set
    // Not just overwritten — CURRENT afterward, which is the property recovery tooling relies on.
    expect(c.isSidecarStale()).toMatchObject({ stale: false, generation: current.generation });
    c.close();
  });

  /**
   * THE RACE HALF of the same ambiguity, pinned separately because it is a DIFFERENT event with a
   * DIFFERENT correct outcome, even though the snapshot alone cannot distinguish it from the rollback
   * test above. Nothing here is fabricated except the ordering: a second declaration really does bump
   * the store and really does refresh the file to the true, current generation — that IS what "a
   * legitimate newer writer of this lineage published" looks like on disk. What cannot be reproduced
   * honestly on one thread is a call whose OWN internal snapshot started before that write landed, so
   * that one piece — and only that piece — is forced back to the stale value, via the same
   * db.prepare interception the "instrumentation write cannot land" test above already uses.
   */
  it("does NOT overwrite a mirror a legitimate newer writer already published — skips as SUPERSEDED", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", {
      tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, syncDeviceId: "machine-a",
    });
    await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    const staleSnapshot = c.sidecarGeneration();

    // The winning writer. Real bump, real refresh — no doctored generation number anywhere here.
    await c.declare({
      species: "rule", stage: "terraform apply", patterns: ["terraform apply"],
      content: "Never apply without a plan review.", severity: "blocking",
      reason: "an unreviewed apply changes infrastructure nobody agreed to change", ...AGENT_RULE,
    });
    const wonTheRace = read(path);
    expect(wonTheRace.generation).toBeGreaterThan(staleSnapshot);
    expect(c.sidecarGeneration()).toBe(wonTheRace.generation);

    // The losing call. Force ONLY its own opening snapshot back to the stale value; everything
    // downstream is real, including the fresh generation read the fix under test performs at decision
    // time — which is what has to see the TRUE, advanced generation for this test to mean anything.
    const db = raw(c) as unknown as { prepare: (sql: string) => unknown };
    const original = db.prepare.bind(db);
    let genReads = 0;
    db.prepare = (sql: string) => {
      if (sql.includes("FROM gate_meta")) {
        genReads += 1;
        if (genReads === 1) return { get: () => ({ generation: staleSnapshot }) };
      }
      return original(sql);
    };
    let result: SidecarMaterialization;
    try {
      result = c.materializeGateMirror();
    } finally {
      db.prepare = original;
    }

    expect(result.outcome).toBe("skipped-superseded");
    expect(read(path)).toEqual(wonTheRace); // untouched, byte for byte — the winner's file survives
    expect(readdirSync(dir)).toEqual(["gate-sidecar.json"]); // no temp file left behind either
    expect(c.isSidecarStale().stale).toBe(false); // still current: the winner was right all along
    c.close();
  });

  it("leaves a mirror from a NEWER build alone on open, rather than thrashing it every time", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const first = await withDeny(path);
    const current = read(path);
    first.close();

    // The one skew we decline. If opening rewrote it, two installs sharing a path would clobber each
    // other on every open — which is the failure the forward-format rule exists to avoid, and an
    // open-time trigger is exactly what would make it constant rather than occasional.
    //
    // This is a REGRESSION GUARD on the new trigger, not a pin on the rule itself: the rule is
    // pinned below by "REFUSES to overwrite a mirror written by a build AHEAD of this one", which is
    // the test that fails if materializeGateMirror's guard is removed. This one fails if the
    // open-time path ever starts bypassing it.
    const fromTheFuture = { ...current, format: 99, entries: [{ somethingWeCannotRead: true }] };
    writeFileSync(path, JSON.stringify(fromTheFuture), "utf8");

    const reopened = new MonetCore(":memory:", {
      tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, syncDeviceId: "machine-a",
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(fromTheFuture); // untouched, byte for byte
    expect(reopened.isSidecarStale()).toMatchObject({ stale: true, reason: "format-ahead" });
    // No tmp debris either: declining happens before the write, not by writing and unlinking.
    expect(readdirSync(dir)).toEqual(["gate-sidecar.json"]);
    reopened.close();
  });

  it("never lets a broken sidecar path fail the CONSTRUCTOR", () => {
    const dir = mkTmp();
    // The path's parent is a FILE, so every write against it fails. Opening a store must still
    // succeed: a mirror that cannot be written is a condition isSidecarStale reports, never a reason
    // somebody's store will not open.
    writeFileSync(join(dir, "notadir"), "i am a file", "utf8");
    const path = join(dir, "notadir", "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "missing" });
    c.close();
  });

  it("does NOT write the mirror on open in report-only mode, however stale the file is", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const first = await withDeny(path);
    const current = read(path);
    first.close();
    // A file the served runtime would rewrite on sight — so if report-only mode writes at all, it
    // writes here.
    writeFileSync(path, JSON.stringify({ ...current, format: 3 }), "utf8");

    // `deferCreatedPin` is the EXISTING declaration that this caller is inspection or dry-run
    // tooling which must never write anything — the same flag that already stops a pin being minted.
    // Opening a store to LOOK at it must not mutate the installation being looked at.
    const inspector = new MonetCore(":memory:", {
      tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, syncDeviceId: "machine-a",
      deferCreatedPin: true,
    });
    expect(read(path).format).toBe(3);
    // It can still SAY the mirror is stale — reporting is what this mode is for.
    expect(inspector.isSidecarStale()).toMatchObject({ stale: true, reason: "format" });
    // And an EXPLICIT call is the caller asking, which the suppression does not countermand.
    expect(inspector.materializeGateMirror().outcome).toBe("written");
    expect(read(path).format).toBe(4);
    inspector.close();

    // The served runtime, for contrast: same file, same staleness, repaired by opening.
    writeFileSync(path, JSON.stringify({ ...current, format: 3 }), "utf8");
    const served = new MonetCore(":memory:", {
      tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, syncDeviceId: "machine-a",
    });
    expect(read(path).format).toBe(4);
    served.close();
  });

  it("creates no mirror at all on a first open in report-only mode", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    // The sharper case: nothing exists yet, so the automatic refresh would CREATE the artifact.
    // Inspection tooling pointed at a path must not bring the file into being.
    const inspector = new MonetCore(":memory:", {
      tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, deferCreatedPin: true,
    });
    expect(existsSync(path)).toBe(false);
    expect(inspector.isSidecarStale()).toMatchObject({ stale: true, reason: "missing" });
    inspector.close();
  });

  it("costs nothing on a store with no sidecar path — construction touches no filesystem", () => {
    const dir = mkTmp();
    // The opt-in is the whole cost control: a store nobody wired a hook to must not write into
    // anyone's directory just because it was constructed.
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    expect(readdirSync(dir)).toEqual([]);
    expect(() => c.isSidecarStale()).toThrow(/needs a path/);
    c.close();
  });

  it("auto-re-materializes from every mutation point when a path is configured", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    const deny = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    expect(read(path).entries).toHaveLength(1);

    // B1's over-block case: withdrawing the deny must take the DENY out of the file, without anyone
    // remembering to re-materialize — but not the rule itself: format 4 mirrors every live rule, so
    // the now-advisory rule stays visible until it is actually retired. Retirement alone is refused
    // while blocking, so the withdrawal is the declaration and the retire is cleanup afterwards.
    await withdrawDeny(c, deny.conceptId, "rm -rf");
    expect(read(path).entries).toHaveLength(1);
    expect(read(path).entries[0]).toMatchObject({ conceptId: deny.conceptId, severity: "advisory" });
    c.retireConcept(deny.conceptId);
    expect(read(path).entries).toEqual([]);
    expect(c.isSidecarStale().stale).toBe(false);
    c.close();
  });

  it("treats a foreign mirror as stale, however current its generation number looks", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const mine = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, syncDeviceId: "machine-a" });
    await mine.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    expect(mine.isSidecarStale().stale).toBe(false);

    // A restored backup, a copied database, or a path a second store was pointed at. A generation
    // counts ONE store's mutations, so comparing it across stores compares nothing — and two stores
    // land on the same small integer constantly. This is the strongest form of the stale-mirror
    // failure: not a missing deny, somebody else's deny.
    const theirs = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, syncDeviceId: "machine-b" });
    await theirs.declare({
      species: "rule", stage: "other gate", patterns: ["Bash:other"],
      content: "A rule from another store entirely.", severity: "blocking",
      reason: "it cannot be undone", ...AGENT_RULE,
    });
    // Same generation number on both sides, different stores.
    expect(theirs.sidecarGeneration()).toBe(mine.sidecarGeneration());
    const verdict = mine.isSidecarStale();
    expect(verdict).toMatchObject({ stale: true, reason: "foreign", fileStoreIdentity: "machine-b", storeIdentity: "machine-a" });
    mine.close();
    theirs.close();
  });

  it("closes the dangling-then-live gap: a binding arriving before its concept", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const src = core({ syncDeviceId: "machine-a" });
    const dst = new MonetCore(":memory:", {
      tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-b", gateSidecarPath: path,
    });
    const deny = await src.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    const payload = src.exportDelta(0);

    // Normative rows relay independently of endpoint liveness, so this ORDER is legitimate, not a
    // corrupted payload: the binding lands first and cannot resolve its rule yet.
    dst.graftRows({ ...payload, concepts: [], observations: [], conceptRevisions: [], contradictions: [] });
    expect(dst.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8")).entries).toEqual([]);

    // Now the concept arrives. Without the concept-arrival bump the deny goes live in gateQuery
    // while the file still reads as CURRENT — a deny the store enforces and the hook cannot see.
    dst.graftRows(payload);
    expect(dst.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules).toHaveLength(1);
    expect(dst.isSidecarStale().stale).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).entries.map((e: { conceptId: string }) => e.conceptId))
      .toEqual([deny.conceptId]);
    src.close();
    dst.close();
  });

  it("regenerates on a graft that lands a deny, and stays pollable when no path is configured", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const src = core({ syncDeviceId: "machine-a" });
    const dst = new MonetCore(":memory:", {
      tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-b", gateSidecarPath: path,
    });
    await src.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    const before = dst.sidecarGeneration();
    dst.graftRows(src.exportDelta(0));
    expect(dst.sidecarGeneration()).toBeGreaterThan(before);
    expect(read(path).entries).toHaveLength(1);
    expect(dst.isSidecarStale().stale).toBe(false);

    // No path configured: the generation still advances, so a 4b consumer can poll it.
    const unwired = core({ syncDeviceId: "machine-c" });
    const unwiredBefore = unwired.sidecarGeneration();
    unwired.graftRows(src.exportDelta(0));
    expect(unwired.sidecarGeneration()).toBeGreaterThan(unwiredBefore);
    src.close();
    dst.close();
    unwired.close();
  });

  /**
   * mergeCircle COMMITS THE ALIAS AND RETURNS WITHOUT REFRESHING (Codex round 1, item 1). The
   * per-concept reassignCircle() calls inside the merge loop each refresh on their own, but every
   * one of those runs BEFORE the alias write lands — the alias is the LAST thing the transaction
   * does — so a mirror rebuilt only from those calls never carries the fresh from→into row, and an
   * EMPTY merge (nothing in `from` to reassign) calls reassignCircle zero times and refreshes
   * NOTHING at all. 4b-C's failure policy deliberately keeps answering BLOCKING from a mirror that
   * has gone stale; a mirror still missing this alias has no entry to answer FROM under the old name
   * at all, so an offline query made under it reads as an ordinary miss instead of the deny the live
   * gate delivers — fail toward allow, the one direction this whole subsystem exists to prevent.
   * Same class, same fix, for archiveCircle/unarchiveCircle below (m5, closed for all three writers
   * that lacked it — renameCircle and reassignCircle already had it).
   */
  it("mergeCircle refreshes the configured sidecar immediately — the alias itself, not just a rule move (Codex round 1, item 1)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", {
      tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, syncDeviceId: "machine-a",
    });
    const deny = await c.declare({
      circle: "proj", species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    await c.mergeCircle("proj", "project");

    // ON DISK, IMMEDIATELY — no separate materialize call, no unrelated write to piggyback a
    // refresh onto.
    const onDisk = read(path);
    expect(onDisk.circleAliases).toEqual([{ from: "proj", to: "project" }]);
    expect(onDisk.entries[0]).toMatchObject({ conceptId: deny.conceptId, circle: "project" });

    // Offline, under the OLD name, delivers exactly what the live gate delivers — the concrete
    // 4b-C consequence Codex named: a mirror missing this alias would silently MISS this query.
    const liveOld = c.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: "proj" });
    const offlineOld = evaluateGateFromMirror(onDisk, { actionContext: "Bash:rm -rf /tmp/x", circle: "proj" });
    expect(offlineOld.rules.map((r) => r.conceptId)).toEqual(liveOld.rules.map((r) => r.conceptId));
    expect(offlineOld.rules.map((r) => r.conceptId)).toEqual([deny.conceptId]);
    c.close();
  });

  it("mergeCircle refreshes even an EMPTY merge — zero concepts in `from`, so zero reassignCircle calls to piggyback a refresh on", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    await c.store("Anchor concept so 'keep' is a real circle.", { circle: "keep", kind: "fact" });
    const before = read(path).generation;
    // "empty-source" holds nothing at all — no concept, no prior alias — which mergeCircle allows
    // (no existence check on `from`, unlike renameCircle's).
    await c.mergeCircle("empty-source", "keep");
    const after = read(path);
    expect(after.generation).toBeGreaterThan(before);
    expect(after.circleAliases).toEqual([{ from: "empty-source", to: "keep" }]);
    c.close();
  });

  it("archiveCircle and unarchiveCircle refresh the configured sidecar too (Codex round 1, item 1 — same class, third writer)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    await c.store("Anchor concept.", { circle: "shelved", kind: "fact" });
    const before = read(path).generation;

    c.archiveCircle("shelved");
    const afterArchive = read(path);
    expect(afterArchive.generation).toBeGreaterThan(before);
    expect(afterArchive.circles).toContain("shelved"); // an archived circle is still "known"

    c.unarchiveCircle("shelved");
    expect(read(path).generation).toBeGreaterThan(afterArchive.generation);
    c.close();
  });

  /**
   * synthesizeRow CAN RETITLE A BOUND RULE WITHOUT BUMPING (Codex round 2, item 4). A rule's TITLE
   * is the text a gate delivers (GateRule.text / GateMirrorEntry.text both read `concepts.title`) —
   * the sieve tier folding new evidence into a dirty rule's body can change `firstLine(body)`, and
   * the live gate serves the new text immediately (a plain SQL read, always current) while a
   * materialized mirror — nothing having told it anything changed — stayed CURRENT-AND-STALE
   * indefinitely: the worst shape of staleness, since isSidecarStale reports it trustworthy.
   */
  it("synthesizing a bound advisory rule's title bumps the generation, refreshes the mirror, and the offline evaluator serves the new text (Codex round 2, item 4)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    const rule = await c.store("Confirm the target path before deleting.", {
      kind: "rule", rule: { stage: "rm -rf", instance: "Bash:rm -rf", ...AGENT_RULE },
    });
    const titleBefore = (await c.getConcept(rule.conceptId, { synthesize: false }))!.title;
    expect(titleBefore).toBe("Confirm the target path before deleting");

    // Force the sieve tier to have real, ORDER-CHANGING work: DeterministicSynthesizer joins
    // observations oldest-first and the title is firstLine() of the join, so a new observation
    // dated BEFORE the existing one is what actually changes `title` — appending one after would
    // leave firstLine(body) reading the same original first line.
    const originalObs = raw(c).prepare(`SELECT id, created_at, embedding FROM observations WHERE concept_id = ?`).get(rule.conceptId) as { id: string; created_at: number; embedding: string };
    raw(c).prepare(
      `INSERT INTO observations (id, content, embedding, concept_id, author_agent_id, circle, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("obs-earlier-evidence", "Always dry-run large deletes first.", originalObs.embedding, rule.conceptId, "local-agent", "default", originalObs.created_at - 1000);
    raw(c).prepare(`UPDATE concepts SET dirty = 1 WHERE id = ?`).run(rule.conceptId);

    const genBefore = c.sidecarGeneration();
    const synthesizedCount = await c.checkpoint("default");
    expect(synthesizedCount).toBeGreaterThan(0);

    const titleAfter = (await c.getConcept(rule.conceptId, { synthesize: false }))!.title;
    expect(titleAfter).toBe("Always dry-run large deletes first");
    expect(titleAfter).not.toBe(titleBefore);

    // THE BUMP — this is the fix itself, not an incidental check.
    expect(c.sidecarGeneration()).toBeGreaterThan(genBefore);

    // THE MIRROR — materialized fresh, carries the NEW text.
    const mirror = c.materializeGateMirror(path).sidecar;
    const entry = mirror.entries.find((e) => e.conceptId === rule.conceptId);
    expect(entry?.text).toBe(titleAfter);

    // THE OFFLINE EVALUATOR — reading only the mirror, agrees with the live gate.
    const live = c.gate({ actionContext: "Bash:rm -rf /tmp/x" });
    const offline = evaluateGateFromMirror(mirror, { actionContext: "Bash:rm -rf /tmp/x", circle: "default" });
    expect(live.rules[0]?.text).toBe(titleAfter);
    expect(offline.rules[0]?.text).toBe(titleAfter);
    c.close();
  });
});

describe("silence never means I gave up", () => {
  it("matches a governed command hidden behind 64KiB of padding, where two prefix caps reported silence", () => {
    const c = core();
    void c.declare({ species: "stage", stage: "git force push", patterns: ["Bash:git push --force"] });
    const padded = `Bash:${"x".repeat(64 * 1024)} && git push --force origin main`;
    const fired = c.gate({ actionContext: padded });
    expect(fired.silence).toBe(false);
    expect(fired.overflow).toBe(false);
    expect(fired.stages.map((st) => st.name)).toEqual(["git force push"]);
    c.close();
  });

  it("reports OVERFLOW, not silence, past the refusal threshold", () => {
    const c = core();
    void c.declare({ species: "stage", stage: "git force push", patterns: ["Bash:git push --force"] });
    const absurd = `Bash:${"x".repeat(4 * 1024 * 1024 + 16)} && git push --force`;
    const result = c.gate({ actionContext: absurd });
    // The two are opposite claims: silence means "nothing governs this", overflow means "I could
    // not tell". A host maps the second to asking the human, never to allowing.
    expect(result.overflow).toBe(true);
    expect(result.silence).toBe(false);
    expect(result.rules).toEqual([]);
    const row = raw(c).prepare(`SELECT overflow FROM gate_events ORDER BY id DESC LIMIT 1`).get() as { overflow: number };
    expect(row.overflow).toBe(1);
    c.close();
  });

  it("does not let a token run cross a command boundary — a newline ends a command", () => {
    const pattern = seedTriggerPattern("Bash:git push --force origin main");
    // `echo git` on one line and `push --force` on the next is two commands; matching across them
    // fires a gate on a command nobody ran. A false positive is the expensive kind of wrong.
    expect(matchesTriggerPattern(pattern, parseActionContext("Bash:echo git\npush --force"))).toBe(false);
    expect(matchesTriggerPattern(pattern, parseActionContext("Bash:echo git\r\npush --force"))).toBe(false);
    // ...and the real thing on one line still fires.
    expect(matchesTriggerPattern(pattern, parseActionContext("Bash:echo hi\ngit push --force origin main"))).toBe(true);
    // Seeding uses the same vocabulary, so both sides segment identically.
    expect(seedTriggerPattern("Bash:cd /x\ngit push --force origin dev").tokens).toEqual(["git", "push", "--force"]);
  });
});

describe("shell fidelity in the shared tokenization", () => {
  const pattern = seedTriggerPattern("Bash:git push --force origin main");
  const fires = (context: string): boolean => matchesTriggerPattern(pattern, parseActionContext(context));

  it("joins a line continuation, because the shell does", () => {
    // Round one made newline a command boundary — correctly — which turned `git \<nl>push` into the
    // token `\npush` and made a continued command MISS its deny. Backslash-newline is a JOIN.
    expect(fires("Bash:git \\\npush --force origin main")).toBe(true);
    expect(fires("Bash:git \\\r\npush --force origin main")).toBe(true);
    expect(parseActionContext("Bash:a\\\nb").tokens).toEqual(["ab"]);
    // ...and an ESCAPED backslash before a newline is not a continuation: the first backslash
    // consumes the second, so the newline reaches the boundary rule on its own.
    expect(parseActionContext("Bash:a\\\\\nb").tokens).toEqual(["a\\", COMMAND_BOUNDARY, "b"]);
    // A bare newline is still a boundary, so the round-one false positive stays fixed.
    expect(fires("Bash:echo git\npush --force")).toBe(false);
  });

  it("strips a shell comment, and only where the shell would", () => {
    // `echo safe # git push --force` runs `echo safe`. Firing inside the comment is a false
    // positive on a command nobody ran.
    expect(fires("Bash:echo safe # git push --force origin main")).toBe(false);
    expect(parseActionContext("Bash:echo safe # secret").tokens).toEqual(["echo", "safe"]);
    // The comment ends at the newline, so the next line is live again.
    expect(fires("Bash:echo safe # nothing here\ngit push --force origin main")).toBe(true);
    // A `#` INSIDE a word is an ordinary character — URLs and fragments survive.
    expect(parseActionContext("Bash:curl http://x/y#frag").tokens).toEqual(["curl", "http://x/y#frag"]);
    expect(parseActionContext("Bash:a#b c").tokens).toEqual(["a#b", "c"]);
    // ...and a QUOTED `#` is data, not a comment.
    expect(parseActionContext(`Bash:echo "# not a comment"`).tokens).toEqual(["echo", "# not a comment"]);
  });
});

describe("corruption narrows a pattern, never widens it", () => {
  it("makes a malformed pattern INERT instead of coercing it into a wildcard", () => {
    // `tool: 42` used to become `tool: null`, which is the ANY-TOOL wildcard: a corrupt row widened
    // the gate's firing surface. A dropped token is the same disease — a shorter run matches more.
    const widened = JSON.stringify([{ tool: 42, tokens: ["git", "push"] }]);
    expect(readTriggerPatterns(widened)).toEqual({ patterns: [], malformed: 1 });
    const shortened = JSON.stringify([{ tool: "Bash", tokens: ["git", null, "--force"] }]);
    expect(readTriggerPatterns(shortened)).toEqual({ patterns: [], malformed: 1 });
    // An absent or explicitly null tool is NOT corruption — that is the legitimate any-tool pattern.
    expect(readTriggerPatterns(JSON.stringify([{ tokens: ["terraform", "apply"] }])).patterns)
      .toEqual([{ tool: null, tokens: ["terraform", "apply"] }]);
    // A good pattern beside a bad one survives; only the bad one is dropped.
    const mixed = JSON.stringify([{ tool: 42, tokens: ["a"] }, { tool: "Bash", tokens: ["git", "push"] }]);
    expect(readTriggerPatterns(mixed)).toEqual({ patterns: [{ tool: "bash", tokens: ["git", "push"] }], malformed: 1 });
  });

  it("surfaces the corruption in curation so a stage that went quiet says why", async () => {
    const c = core();
    await c.declare({ species: "stage", stage: "rm -rf", patterns: ["Bash:rm -rf", "Bash:rm -fr"] });
    const stageId = c.stages()[0]!.id;
    raw(c).prepare(`UPDATE stages SET trigger_patterns = ? WHERE id = ?`)
      .run(JSON.stringify([{ tool: 42, tokens: ["rm", "-rf"] }, { tool: "Bash", tokens: ["rm", "-fr"] }]), stageId);

    // The corrupt pattern fires on NOTHING rather than on everything.
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).silence).toBe(true);
    expect(c.gate({ actionContext: "Read:/etc/hosts" }).silence).toBe(true);
    expect(c.gate({ actionContext: "Bash:rm -fr /tmp/x" }).silence).toBe(false);
    expect(c.gateStats().malformedPatterns).toEqual([
      { stageId, stageName: "rm -rf", malformed: 1, readable: ["bash: rm -fr"] },
    ]);
    c.close();
  });
});

describe("overflow is not silence, in the metrics either", () => {
  it("counts refusals separately from confident silences", () => {
    const c = core();
    void c.declare({ species: "stage", stage: "rm -rf", patterns: ["Bash:rm -rf"] });
    c.gate({ actionContext: "Bash:rm -rf /tmp/x" });                    // fire
    c.gate({ actionContext: "Bash:git status" });                       // silence
    c.gate({ actionContext: `Bash:${"x".repeat(4 * 1024 * 1024 + 16)}` }); // overflow
    // Deriving silence as "not a fire" folded refusals in, inflating exactly the confident-silence
    // rate the design's validation checks read.
    expect(c.gateStats()).toMatchObject({ windowTotal: 3, fires: 1, silences: 1, overflows: 1 });
    c.close();
  });
});

describe("model-tag retirement", () => {
  it("delivers a compensation only to the model it compensates for", async () => {
    const c = core();
    const forOld = await c.store("Old model forgets to quote paths.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force", scope: "agent", modelTag: "model-1" },
    });
    const domain = await c.store("Force-push destroys shared history.", {
      kind: "rule", rule: { stage: "git force push", scope: "domain" },
    });

    // No tag supplied: nothing is filtered. A caller that does not know which model it is must not
    // have its rules silently vanish.
    expect(c.gate({ actionContext: "Bash:git push --force" }).rules.map((r) => r.conceptId).sort())
      .toEqual([forOld.conceptId, domain.conceptId].sort());
    // The model it was captured for still gets it.
    expect(c.gate({ actionContext: "Bash:git push --force", runtimeModelTag: "model-1" }).rules.map((r) => r.conceptId).sort())
      .toEqual([forOld.conceptId, domain.conceptId].sort());
    // A DIFFERENT model does not inherit the last model's defects as instructions...
    const next = c.gate({ actionContext: "Bash:git push --force", runtimeModelTag: "model-2" });
    expect(next.rules.map((r) => r.conceptId)).toEqual([domain.conceptId]);

    // ...and the filtered rule surfaces for curation rather than being retired by machinery.
    expect(c.gateStats("default", 30, "model-2").retirementCandidates).toEqual([
      { conceptId: forOld.conceptId, title: "Old model forgets to quote paths", modelTag: "model-1", stageName: "git force push" },
    ]);
    expect(c.gateStats("default", 30, "model-1").retirementCandidates).toEqual([]);
    expect(c.gateStats().retirementCandidates).toEqual([]); // no tag, nothing to be a candidate against
    // FILTERED IS NOT RETIRED: the rule is still stored, still bound, still findable.
    expect(c.ruleBinding(forOld.conceptId)).toMatchObject({ severity: "advisory", model_tag: "model-1" });
    c.close();
  });

  it("takes the runtime tag from the store when the call does not name one", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, runtimeModelTag: "model-2" });
    const forOld = await c.store("A compensation for the old model.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force", scope: "agent", modelTag: "model-1" },
    });
    expect(c.gate({ actionContext: "Bash:git push --force" }).rules).toEqual([]);
    expect(c.gateStats().retirementCandidates.map((r) => r.conceptId)).toEqual([forOld.conceptId]);
    c.close();
  });
});

// ---------------------------------------------------------------------------
// modelTag length bound (Codex round 4, item 2)
// ---------------------------------------------------------------------------
describe("modelTag length bound — MODEL_TAG_MAX_CHARS", () => {
  it("treats a WHITESPACE-ONLY modelTag as absent — refused at capture, declare, and the graft boundary", async () => {
    // "   " is truthy in JS and non-null in SQL, so it passed every presence check while being a
    // tag no runtime ever equals: a rule that looks configured and never delivers. Whitespace is
    // absence, at every surface that minted or relayed one.
    const c = core();
    await expect(
      c.store("A compensation.", { kind: "rule", rule: { stage: "ws", scope: "agent", modelTag: "   " } }),
    ).rejects.toThrow(/requires rule\.modelTag/);
    // declare()'s OWN early check (review fix — round 5 follow-up: fast-path consistency) now
    // catches this itself, with its OWN field's name ("modelTag", not "rule.modelTag" — DeclareInput
    // has no `rule` field) — before this fix it wasn't whitespace-aware and fell through to
    // declare()'s internal store() delegation, whose validateRuleCapture caught it instead, under
    // store()'s OWN "rule.modelTag" phrasing. Same refusal, earlier and correctly named.
    await expect(
      c.declare({ species: "rule", stage: "ws2", content: "Text.", scope: "agent", modelTag: "\t \n" }),
    ).rejects.toThrow(/requires modelTag/);
    c.close();

    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    const ok = await src.declare({
      species: "rule", stage: "ws3", patterns: ["Bash:frob"],
      content: "A compensation.", severity: "advisory", ...AGENT_RULE,
    });
    if (ok.species !== "rule") throw new Error("unreachable");
    const payload = src.exportDelta(0);
    const tampered = {
      ...payload,
      ruleBindings: payload.ruleBindings!.map((b) => ({ ...b, model_tag: "   " })),
    };
    expect(() => dst.graftRows(tampered)).toThrow(/whitespace-only model tag/);
    src.close();
    dst.close();
  });

  it("TRIMS a padded nonblank modelTag before storage — stores/delivers the canonical form, at BOTH capture entrances (Codex round 5 follow-up, item 1a)", async () => {
    const padded = "  gpt-4  ";
    const trimmed = "gpt-4";

    const c = core();
    const stored = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force", scope: "agent", modelTag: padded },
    });
    // STORED CANONICAL, not padded — bindRule trims before writing, the same canonical-form
    // discipline normalizeStageName already enforces for stage names.
    expect(c.ruleBinding(stored.conceptId)!.model_tag).toBe(trimmed);
    // DELIVERS under the TRIMMED runtime tag, on BOTH matchers — setRuntimeModelTag already trims
    // the RUNTIME side (round 4), so this only round-trips if storage now agrees on the same
    // canonical form; the SQL comparison (RULE_LIVENESS_WHERE) is exact, never trimmed at read time.
    expect(c.gate({ actionContext: "Bash:git push --force", runtimeModelTag: trimmed }).rules.map((r) => r.conceptId))
      .toEqual([stored.conceptId]);
    expect(c.stageLookup({ stage: "git force push", runtimeModelTag: trimmed }).rules.map((r) => r.conceptId))
      .toEqual([stored.conceptId]);
    c.close();

    const d = core();
    const declared = await d.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a directory tree unattended.",
      scope: "agent", modelTag: padded,
    });
    if (declared.species !== "rule") throw new Error("unreachable");
    expect(d.ruleBinding(declared.conceptId)!.model_tag).toBe(trimmed);
    d.close();
  });

  it("REFUSES a relayed rule binding whose model_tag is padded — naming both forms — graft preflight (Codex round 5 follow-up, item 1a)", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    const rule = await src.declare({
      species: "rule", stage: "s", content: "Text.", severity: "advisory", scope: "agent", modelTag: "gpt-4",
    });
    if (rule.species !== "rule") throw new Error("unreachable");
    const payload = src.exportDelta(0);
    // No honest peer can hold this — bindRule trims at creation — so relay is the only route, same
    // lattice as the whitespace-only and over-length checks beside it.
    const tampered = {
      ...payload,
      ruleBindings: payload.ruleBindings!.map((b) => ({ ...b, model_tag: "  gpt-4  " })),
    };
    expect(() => dst.graftRows(tampered)).toThrow(
      /has a padded model tag '  gpt-4  ' \(would trim to 'gpt-4'\)/,
    );
    src.close();
    dst.close();
  });

  it("REFUSES an over-max modelTag at both engine capture paths — store()'s validateRuleCapture and declare()'s own early copy", async () => {
    const c = core();
    const overLong = "m".repeat(MODEL_TAG_MAX_CHARS + 1);
    await expect(
      c.store("A compensation.", { kind: "rule", rule: { stage: "s", scope: "agent", modelTag: overLong } }),
    ).rejects.toThrow(new RegExp(`at most ${MODEL_TAG_MAX_CHARS} characters`));
    await expect(
      c.declare({ species: "rule", stage: "s2", content: "Text.", scope: "agent", modelTag: overLong }),
    ).rejects.toThrow(new RegExp(`at most ${MODEL_TAG_MAX_CHARS} characters`));
    // The refusal was total: neither stage was left half-created with an unbound rule.
    expect(c.stageLookup({ stage: "s" }).matched).toBe(false);
    expect(c.stageLookup({ stage: "s2" }).matched).toBe(false);
    c.close();
  });

  it("REFUSES an over-max modelTag at bindRule itself — the authoritative, transaction-internal copy, independent of the early checks", async () => {
    const c = core();
    const rule = await c.store("A domain rule to rebind.", { kind: "rule", rule: { stage: "s", scope: "domain" } });
    const stageId = c.ruleBinding(rule.conceptId)!.stage_id;
    const deps = { db: raw(c) as never, newId: () => "unused", nextSyncTimestamp: () => Date.now(), syncDeviceId: "d" };
    const overLong = "m".repeat(MODEL_TAG_MAX_CHARS + 1);
    // Calling bindRule DIRECTLY, bypassing store()/declare()'s own early copies entirely — the same
    // technique the "PATH 2" TOCTOU test above uses to prove a guard lives at the mutation itself,
    // not only at the API edge.
    expect(() => bindRule(deps, {
      conceptId: rule.conceptId, stageId, scope: "agent", modelTag: overLong, origin: "correction", circle: "default",
    }, "replace")).toThrow(new RegExp(`at most ${MODEL_TAG_MAX_CHARS} characters`));
    c.close();
  });

  it("REFUSES setRuntimeModelTag(...) called directly with an over-max tag", async () => {
    const c = core();
    const overLong = "m".repeat(MODEL_TAG_MAX_CHARS + 1);
    expect(() => c.setRuntimeModelTag(overLong)).toThrow(new RegExp(`at most ${MODEL_TAG_MAX_CHARS} characters`));
    c.close();
  });

  it("REFUSES a relayed rule binding whose model_tag exceeds MODEL_TAG_MAX_CHARS — graft preflight", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    const rule = await src.declare({
      species: "rule", stage: "s", content: "Text.", severity: "advisory", scope: "agent", modelTag: "model-1",
    });
    if (rule.species !== "rule") throw new Error("unreachable");
    const payload = src.exportDelta(0);
    const overLong = "m".repeat(MODEL_TAG_MAX_CHARS + 1);
    // No honest peer can hold this — bindRule refuses it at creation — so relay is the only route,
    // same lattice as the over-length/non-canonical stage-name checks above.
    const tampered = {
      ...payload,
      ruleBindings: payload.ruleBindings!.map((b) => ({ ...b, model_tag: overLong })),
    };
    expect(() => dst.graftRows(tampered)).toThrow(
      new RegExp(`has a ${overLong.length}-character model tag \\(max ${MODEL_TAG_MAX_CHARS}\\)`),
    );
    src.close();
    dst.close();
  });

  it("an EXACTLY-at-max modelTag passes end to end: store(), delivered via gate() AND stageLookup(), and grafts cleanly", async () => {
    const src = core({ syncDeviceId: "machine-a" });
    const dst = core({ syncDeviceId: "machine-b" });
    const atMax = "m".repeat(MODEL_TAG_MAX_CHARS);
    const stored = await src.store("Never force-push to a shared branch.", {
      kind: "rule",
      rule: { stage: "git force push", instance: "Bash:git push --force", scope: "agent", modelTag: atMax },
    });
    expect(src.ruleBinding(stored.conceptId)!.model_tag).toBe(atMax);
    expect(src.gate({ actionContext: "Bash:git push --force", runtimeModelTag: atMax }).rules.map((r) => r.conceptId))
      .toEqual([stored.conceptId]);
    expect(src.stageLookup({ stage: "git force push", runtimeModelTag: atMax }).rules.map((r) => r.conceptId))
      .toEqual([stored.conceptId]);

    const payload = src.exportDelta(0);
    dst.graftRows(payload);
    expect(dst.ruleBinding(stored.conceptId)!.model_tag).toBe(atMax);
    src.close();
    dst.close();
  });
});

// ---------------------------------------------------------------------------
// the recognized matcher
// ---------------------------------------------------------------------------
describe("stageLookup — the recognized matcher", () => {
  it("delivers the same rules gateQuery delivers for that stage — parity through the chokepoint", async () => {
    const c = core();
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule",
      rule: { stage: "git force push", instance: "Bash:git push --force origin main", reason: "it destroys teammates' commits", ...AGENT_RULE },
    });
    const viaGate = c.gate({ actionContext: "Bash:cd /repo && git push --force origin dev" });
    const viaLookup = c.stageLookup({ stage: "git force push" });

    expect(viaGate.rules).toHaveLength(1);
    expect(viaLookup.matched).toBe(true);
    expect(viaLookup.rules).toHaveLength(1);
    // Same delivery in every field gateQuery also carries — the one field stageLookup adds on top
    // (`body`) is stripped before the comparison, so this pins the shared chokepoint fields exactly.
    const { body: _body, ...deliveredWithoutBody } = viaLookup.rules[0]!;
    expect(deliveredWithoutBody).toEqual(viaGate.rules[0]);
    expect(viaLookup.rules[0]!.conceptId).toBe(rule.conceptId);
    c.close();
  });

  it("excludes a foreign-model agent-scoped rule on BOTH surfaces alike", async () => {
    const c = core();
    const forOld = await c.store("Old model forgets to quote paths.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force", scope: "agent", modelTag: "model-1" },
    });
    const domain = await c.store("Force-push destroys shared history.", {
      kind: "rule", rule: { stage: "git force push", scope: "domain" },
    });

    const gateResult = c.gate({ actionContext: "Bash:git push --force", runtimeModelTag: "model-2" });
    const lookupResult = c.stageLookup({ stage: "git force push", runtimeModelTag: "model-2" });

    expect(gateResult.rules.map((r) => r.conceptId)).toEqual([domain.conceptId]);
    expect(lookupResult.rules.map((r) => r.conceptId)).toEqual([domain.conceptId]);
    expect(forOld.conceptId).not.toBe(domain.conceptId); // sanity: the excluded rule really exists
    c.close();
  });

  it("resolves case-insensitively/trimmed, exact id first — no fuzzy matching", async () => {
    const c = core();
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "Git Force Push", ...AGENT_RULE },
    });
    const stageId = c.ruleBinding(rule.conceptId)!.stage_id;
    expect(c.stageLookup({ stage: "  GIT force PUSH  " }).matched).toBe(true);
    expect(c.stageLookup({ stage: stageId }).matched).toBe(true);
    // No fuzzy match: a near-miss name is a miss, not a hit on the nearest stage.
    expect(c.stageLookup({ stage: "git forced push" }).matched).toBe(false);
    c.close();
  });

  it("is a HIT with rules:[] for a stage that exists but has none bound — never a miss", async () => {
    const c = core();
    await c.declare({ species: "stage", stage: "terraform apply", patterns: ["terraform apply"] });
    const r = c.stageLookup({ stage: "terraform apply" });
    expect(r).toMatchObject({ matched: true, rules: [] });
    expect(r.stage).toMatchObject({ name: "terraform apply" });
    expect(r.stageIndex).toBeUndefined(); // only a MISS carries the index
    c.close();
  });

  it("a miss carries the live stage index; a hit does not", async () => {
    const c = core();
    await c.store("Never force-push to a shared branch.", { kind: "rule", rule: { stage: "git force push", ...AGENT_RULE } });

    const hit = c.stageLookup({ stage: "git force push" });
    expect(hit.stageIndex).toBeUndefined();

    const miss = c.stageLookup({ stage: "no such stage" });
    expect(miss.matched).toBe(false);
    expect(miss.stage).toBeNull();
    expect(miss.rules).toEqual([]);
    expect(miss.stageIndex).toEqual(["git force push"]);
    c.close();
  });

  it("delivers body when non-blank; gateQuery's GateRule never carries the field at all", async () => {
    const c = core();
    const rule = await c.store("Run the review watcher.", {
      kind: "rule", rule: { stage: "starting a review pass", ...AGENT_RULE },
    });
    // Set a known, exact body directly — decoupled from whatever an unsynthesized capture's own
    // body happens to be, since this test is about stageLookup's delivery, not synthesis timing.
    raw(c).prepare(`UPDATE concepts SET body = ? WHERE id = ?`).run(
      "watch-reviews team-monet/monet-core --interval 5m", rule.conceptId,
    );
    const r = c.stageLookup({ stage: "starting a review pass" });
    expect(r.rules[0]!.body).toBe("watch-reviews team-monet/monet-core --interval 5m");

    // gateQuery's own delivery type carries no `body` field at all — pin the SHAPE, not just a value.
    await c.declare({ species: "stage", stage: "trigger it mechanically", patterns: ["Bash:review-pass"] });
    await c.store("Run the review watcher, mechanically triggered.", {
      kind: "rule", rule: { stage: "trigger it mechanically", ...AGENT_RULE },
    });
    const viaGate = c.gate({ actionContext: "Bash:review-pass" });
    expect(viaGate.rules[0]).not.toHaveProperty("body");
    c.close();
  });

  it("blank/whitespace-only body normalizes to null", async () => {
    const c = core();
    const rule = await c.store("A rule with a blank body.", {
      kind: "rule", rule: { stage: "blank body stage", ...AGENT_RULE },
    });
    raw(c).prepare(`UPDATE concepts SET body = ? WHERE id = ?`).run("   \n  ", rule.conceptId);
    const r = c.stageLookup({ stage: "blank body stage" });
    expect(r.rules[0]!.body).toBeNull();
    c.close();
  });

  it("gate_events rows: mechanical vs recognized land correctly, and a recognized MISS is recorded too", async () => {
    const c = core();
    await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    c.gate({ actionContext: "Bash:git push --force" });        // mechanical hit
    c.stageLookup({ stage: "git force push" });                // recognized hit
    c.stageLookup({ stage: "no such stage at all" });           // recognized MISS

    const rows = raw(c).prepare(`SELECT action_context, matcher, matched_stage_id FROM gate_events ORDER BY id`)
      .all() as Array<{ action_context: string; matcher: string; matched_stage_id: string | null }>;
    expect(rows).toHaveLength(3);
    expect(rows[0]!.matcher).toBe("mechanical");
    expect(rows[0]!.matched_stage_id).not.toBeNull();
    expect(rows[1]).toMatchObject({ matcher: "recognized", action_context: "git force push" });
    expect(rows[1]!.matched_stage_id).not.toBeNull();
    // THE MISS: recorded, matcher='recognized', matched_stage_id NULL, action_context = what was asked.
    expect(rows[2]).toMatchObject({ matcher: "recognized", action_context: "no such stage at all", matched_stage_id: null });
    c.close();
  });

  it("schema upgrade: a store created before `matcher` existed gets the column, and both matchers write successfully", async () => {
    const dir = mkTmp();
    const dbPath = join(dir, "pre-matcher.db");
    const old = new Database(dbPath);
    // The pre-column shape — every gate_events column this slice's ALTER adds `matcher` on top of.
    old.exec(`
      CREATE TABLE gate_events (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        action_context TEXT NOT NULL,
        matched_stage_id TEXT,
        rule_count INTEGER NOT NULL,
        max_severity TEXT,
        latency_us INTEGER NOT NULL,
        circle TEXT NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
        overflow INTEGER NOT NULL DEFAULT 0 CHECK (overflow IN (0, 1))
      );
    `);
    // A pre-existing row, exactly as an old binary would have left one — proves the guard is a
    // real ALTER against a populated table, not merely a fresh CREATE TABLE that happens to include it.
    old.prepare(
      `INSERT INTO gate_events (ts, action_context, matched_stage_id, rule_count, max_severity, latency_us, circle, truncated, overflow)
       VALUES (1000, 'Bash:old row', NULL, 0, NULL, 5, 'default', 0, 0)`,
    ).run();
    old.close();

    const c = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
    try {
      const cols = raw(c).prepare(`PRAGMA table_info(gate_events)`).all() as Array<{ name: string }>;
      expect(cols.some((col) => col.name === "matcher")).toBe(true);
      // The pre-existing row backfilled to 'mechanical' — true by construction, since 'recognized'
      // did not exist before this slice.
      expect(raw(c).prepare(`SELECT matcher FROM gate_events WHERE action_context = 'Bash:old row'`).get())
        .toEqual({ matcher: "mechanical" });

      // Both matchers write successfully against the migrated store.
      await c.store("Never force-push to a shared branch.", { kind: "rule", rule: { stage: "git force push", ...AGENT_RULE } });
      c.gate({ actionContext: "Bash:git push --force" });
      c.stageLookup({ stage: "git force push" });
      c.stageLookup({ stage: "no such stage" });

      const matchers = raw(c).prepare(`SELECT matcher FROM gate_events WHERE action_context != 'Bash:old row' ORDER BY id`)
        .all() as Array<{ matcher: string }>;
      expect(matchers.map((m) => m.matcher)).toEqual(["mechanical", "recognized", "recognized"]);
    } finally {
      c.close();
    }
  });

  it("re-aiming a stage's patterns reroutes the MECHANICAL matcher only — recognized delivery is unaffected (doctrine, item 7)", async () => {
    const c = core();
    const deny = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a directory tree unattended.", severity: "blocking", reason: "there is no undo",
      ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules.map((r) => r.conceptId)).toEqual([deny.conceptId]);
    expect(c.stageLookup({ stage: "rm -rf" }).rules.map((r) => r.conceptId)).toEqual([deny.conceptId]);

    // Re-aim the stage's MECHANICAL firing surface to a shape that no longer matches the old
    // action — acknowledging the deny, exactly as the guard requires.
    await c.declare({
      species: "stage", stage: "rm -rf", patterns: ["Bash:something-else-entirely"],
      acknowledgeBlockingRules: [deny.conceptId],
    });

    // MECHANICAL reachability changed: the deny no longer fires on the old action shape.
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules).toEqual([]);
    // RECOGNIZED reachability did NOT change: the SAME deny is still delivered by name, severity
    // and all — pattern re-aiming is not a rule-withdrawal lever on either matcher (doctrine).
    const stillReachable = c.stageLookup({ stage: "rm -rf" });
    expect(stillReachable.rules.map((r) => r.conceptId)).toEqual([deny.conceptId]);
    expect(stillReachable.rules[0]!.severity).toBe("blocking");
    c.close();
  });
});

// ---------------------------------------------------------------------------
// createGateSchema — concurrent-migrator race (Codex round 3, item 5)
// ---------------------------------------------------------------------------

/**
 * Simulates the documented race's STALE READ: a second migrator's PRAGMA probe, taken before a
 * first migrator's ALTER committed, reports the `matcher` column absent — regardless of what the
 * REAL table underneath already has. Only `.all()` is ever called on the intercepted statement by
 * createGateSchema, so only it needs the faked answer; every other statement (including the ALTER
 * this stale answer provokes) passes straight through to the real connection, so the resulting
 * error is REAL SQLite output, not a fabricated one.
 */
class StaleMatcherProbeStorage extends BetterSqlitePort {
  private probeConsumed = false;

  override prepare(sql: string): Statement {
    const statement = super.prepare(sql);
    if (this.probeConsumed || !/^\s*PRAGMA table_info\(gate_events\)/.test(sql)) return statement;
    this.probeConsumed = true;
    return {
      run: (...params: unknown[]) => statement.run(...params),
      get: (...params: unknown[]) => statement.get(...params),
      all: () => [],
    };
  }
}

describe("createGateSchema — concurrent-migrator race", () => {
  it("a stale second-migrator probe hits a REAL duplicate-column error, caught as success — startup does not abort (Codex round 3, item 5)", () => {
    const dir = mkTmp();
    const path = join(dir, "monet.db");

    // FIRST MIGRATOR: an ordinary open against a brand-new file. The CREATE TABLE declares
    // `matcher` inline, so this alone leaves the column present — the WINNER of the race.
    const winner = new BetterSqlitePort(path);
    createGateSchema(winner);
    winner.close();

    // SECOND MIGRATOR: a fresh connection to the SAME (already-migrated) file, but its own PRAGMA
    // probe is stale (the race — two processes opening a pre-column store at once is the SUPPORTED
    // MCP+CLI topology storage.ts's WAL + busy_timeout setup exists for) and reports the column
    // absent. createGateSchema proceeds to the ALTER exactly as the real guard would, and hits
    // SQLite's real "duplicate column name" error against the real, already-migrated table.
    const loser = new StaleMatcherProbeStorage(path);
    expect(() => createGateSchema(loser)).not.toThrow();

    // NOT CORRUPTED: exactly one `matcher` column, not two — the catch swallowed the race; it did
    // not paper over a real schema problem.
    const cols = loser.prepare(`PRAGMA table_info(gate_events)`).all() as Array<{ name: string }>;
    expect(cols.filter((c) => c.name === "matcher")).toHaveLength(1);
    loser.close();
  });
});

/**
 * SAME TECHNIQUE, A DIFFERENT TABLE (post-merge review round, P2): `StaleMatcherProbeStorage` above
 * simulates the race for gate_events' own `matcher` column; this is its twin for
 * `ingest_operations`' four receipt columns (`rule_previous_severity`, `rule_previous_circle`,
 * `rule_circle`, `rule_severity`) — engine.ts's own `migrate()`, not gates.ts's `migrateGateColumns`,
 * but the identical race shape: a second migrator's PRAGMA probe, taken before a first migrator's
 * ALTER committed, reports a column absent regardless of what the REAL table underneath already has.
 * `migrate()` is PRIVATE, reachable only through `MonetCore`'s own constructor — unlike
 * `createGateSchema` above, there is no lighter-weight standalone entry point to call directly, so
 * this constructs a full `MonetCore` against the probe port.
 *
 * FILTERS OUT ONLY THE FOUR TARGET COLUMNS, not the whole result — unlike `StaleMatcherProbeStorage`
 * above (which can safely blank the ENTIRE result, since `matcher` is the only column that guard
 * ever checks). `ingest_operations` carries OTHER guarded-but-uncaught ALTERs sharing this exact
 * PRAGMA read (`writer_domain`, `source_concept_id` — a separate, out-of-scope observation; see the
 * round's own report) — blanking the whole result made THOSE columns look stale too, so migrate()
 * threw on `writer_domain` before ever reaching the four columns this test targets. Filtering the
 * REAL result down to "everything except these four" keeps the race scoped to exactly what this
 * round fixed.
 */
class StaleIngestOperationsColumnProbeStorage extends BetterSqlitePort {
  private probeConsumed = false;
  private static readonly TARGET_COLUMNS = new Set([
    "rule_previous_severity", "rule_previous_circle", "rule_circle", "rule_severity",
    // The two older siblings in the same guarded-ALTER cluster gained the identical catch (the
    // worker's own flagged adjacency) — the probe hides them too, so the race is exercised across
    // the WHOLE cluster rather than the four columns the finding happened to name.
    "writer_domain", "source_concept_id",
  ]);

  override prepare(sql: string): Statement {
    const statement = super.prepare(sql);
    if (this.probeConsumed || !/^\s*PRAGMA table_info\(ingest_operations\)/.test(sql)) return statement;
    this.probeConsumed = true;
    return {
      run: (...params: unknown[]) => statement.run(...params),
      get: (...params: unknown[]) => statement.get(...params),
      all: () =>
        (statement.all() as Array<{ name: string }>).filter(
          (c) => !StaleIngestOperationsColumnProbeStorage.TARGET_COLUMNS.has(c.name),
        ),
    };
  }
}

describe("MonetCore construction — ingest_operations receipt-column concurrent-migrator race", () => {
  it("a stale second-migrator probe hits REAL duplicate-column errors on all four receipt columns, caught as success — construction does not abort (post-merge review round, P2)", () => {
    const dir = mkTmp();
    const path = join(dir, "monet.db");

    // FIRST MIGRATOR: an ordinary construction against a brand-new file. `ingest_operations`' own
    // CREATE TABLE does NOT declare any of the four receipt columns inline (unlike gate_events'
    // `matcher`) — so even this FIRST, uncontested construction reaches all four guarded ALTERs, and
    // is the WINNER of the race regardless of file freshness.
    const winner = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1 });
    winner.close();

    // SECOND MIGRATOR: a fresh connection to the SAME (already-migrated) file, but its own PRAGMA
    // probe is stale — the SAME supported MCP+CLI-sharing-one-`.monet`-DB topology
    // `StaleMatcherProbeStorage`'s own comment names — and reports all four columns absent. Every one
    // of the four guarded ALTERs proceeds exactly as the real guard would, and each hits SQLite's
    // real "duplicate column name" error against the real, already-migrated table. BEFORE this
    // round's fix, the FIRST of the four to throw aborted this process's entire construction —
    // startup crashing on nothing more than losing a race the winner already resolved correctly.
    const loser = new StaleIngestOperationsColumnProbeStorage(path);
    expect(() => new MonetCore(loser, { tauAttach: 1.1, tauAmbiguous: 1.1 })).not.toThrow();

    // NOT CORRUPTED: exactly one of each column, not two — the catch swallowed the race for all
    // four; it did not paper over a real schema problem.
    const cols = loser.prepare(`PRAGMA table_info(ingest_operations)`).all() as Array<{ name: string }>;
    for (const name of ["rule_previous_severity", "rule_previous_circle", "rule_circle", "rule_severity"]) {
      expect(cols.filter((c) => c.name === name), name).toHaveLength(1);
    }
    loser.close();
  });
});

// ---------------------------------------------------------------------------
// createGateSchema — the circle column migration (BLOCKER B1)
// ---------------------------------------------------------------------------
/**
 * The migration test the suite lacked. `idx_rule_bindings_circle` used to live inside
 * GATE_SCHEMA_SQL, which execs unconditionally and FIRST on every open — including an upgraded
 * store where `circle` does not exist as a column yet. `CREATE TABLE IF NOT EXISTS` degrades safely
 * there; `CREATE INDEX ... ON rule_bindings(circle)` does not — it names a real column SQLite
 * evaluates immediately, so every store that predates this slice failed to open with "no such
 * column: circle" the instant this index sat ahead of the guarded ALTER that adds it. Fixed by
 * moving the index to LAST in createGateSchema, after the ALTER and the backfill both complete.
 *
 * This block rebuilds a GENUINE pre-breadth `rule_bindings` — the real legacy DDL, not a stripped
 * stand-in — so the open, the backfill, and the concurrent-migrator race are all proven against the
 * actual shape a store that predates this slice has on disk.
 */
const LEGACY_RULE_BINDINGS_DDL = `
  CREATE TABLE rule_bindings (
    concept_id TEXT PRIMARY KEY,
    stage_id TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('advisory','blocking')),
    scope TEXT NOT NULL CHECK (scope IN ('domain','agent')),
    model_tag TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('correction','declaration','projection','import')),
    declared_by TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL,
    sync_updated_at INTEGER NOT NULL,
    sync_revision INTEGER NOT NULL DEFAULT 0,
    sync_writer TEXT,
    CHECK (severity != 'blocking' OR origin = 'declaration'),
    CHECK ((scope = 'agent') = (model_tag IS NOT NULL))
  )`;

/**
 * Rebuilds `rule_bindings` to the EXACT pre-breadth shape, in place: rename, recreate the legacy
 * DDL, copy every row across by an explicit column list (so `circle` cannot leak through), drop the
 * rename. The index is dropped first — it names the column this is about to remove.
 */
function downgradeToPreBreadthSchema(path: string): void {
  const db = new Database(path);
  db.exec(`DROP INDEX IF EXISTS idx_rule_bindings_circle`);
  // trg_rule_bindings_backfill_circle (round 5, ON rule_bindings) needs no explicit drop: SQLite
  // rewrites a trigger's body to follow ALTER TABLE ... RENAME TO, so it survives the rename below as
  // "ON rule_bindings_new" and is then dropped for real, automatically, by the final DROP TABLE
  // rule_bindings_new — a genuinely pre-breadth store has no such trigger, and this reaches that
  // state without help. trg_rule_bindings_follow_concept_circle (round 7, item 2, ON concepts) gets
  // NO such help — it is scoped to a table this function never renames or drops, so it would
  // otherwise survive this whole dance unchanged, still referencing rule_bindings.circle, and throw
  // "no such column: circle" the moment anything updates a concept's circle against the
  // no-circle-column LEGACY_RULE_BINDINGS_DDL shape this function is about to install. Dropped
  // explicitly, for the identical reason: a genuinely pre-breadth store has none of this either.
  db.exec(`DROP TRIGGER IF EXISTS trg_rule_bindings_follow_concept_circle`);
  db.exec(`ALTER TABLE rule_bindings RENAME TO rule_bindings_new`);
  db.exec(LEGACY_RULE_BINDINGS_DDL);
  db.exec(`INSERT INTO rule_bindings
             SELECT concept_id, stage_id, severity, scope, model_tag, origin, declared_by, reason,
                    created_at, sync_updated_at, sync_revision, sync_writer
               FROM rule_bindings_new`);
  db.exec(`DROP TABLE rule_bindings_new`);
  db.close();
}

describe("createGateSchema — the circle column migration (BLOCKER B1)", () => {
  it("opens a genuine pre-breadth store, backfills every binding to its concept's CURRENT circle (including one whose concept moved circles before the upgrade), idempotently, and survives the two-migrator race", async () => {
    const dir = mkTmp();
    const path = join(dir, "store.db");

    // Build a real, populated store on the CURRENT schema, then rebuild the table to the exact
    // shape a pre-breadth store has on disk.
    const built = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
    await built.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking",
      reason: "there is no undo", circle: "alpha", ...AGENT_RULE,
    });
    const moved = await built.store("Confirm the target path first.", {
      circle: "alpha", kind: "rule", rule: { stage: "rm -rf", ...AGENT_RULE },
    });
    await built.store("Prefer npm ci.", {
      circle: "beta", kind: "rule", rule: { stage: "npm install", instance: "Bash:npm install", ...AGENT_RULE },
    });
    // This concept moves circles BEFORE the downgrade — the backfill must follow the CONCEPT's
    // CURRENT circle ("gamma"), not whatever the binding might have remembered.
    built.reassignCircle(moved.conceptId, "gamma");
    const preDowngrade = raw(built)
      .prepare(`SELECT concept_id, severity, circle FROM rule_bindings ORDER BY concept_id`)
      .all() as Array<{ concept_id: string; severity: string; circle: string }>;
    expect(preDowngrade.find((r) => r.concept_id === moved.conceptId)?.circle).toBe("gamma");
    built.close();

    downgradeToPreBreadthSchema(path);
    const legacyCols = (new Database(path).prepare(`PRAGMA table_info(rule_bindings)`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(legacyCols).not.toContain("circle");

    // A DANGLING binding with no concept at all — the one row the backfill genuinely cannot
    // resolve, and must not crash on.
    {
      const legacy = new Database(path);
      legacy.prepare(
        `INSERT INTO rule_bindings (concept_id, stage_id, severity, scope, model_tag, origin, declared_by,
                                    reason, created_at, sync_updated_at, sync_revision, sync_writer)
         VALUES ('ghost-concept', (SELECT id FROM stages LIMIT 1), 'blocking', 'domain', NULL, 'declaration', NULL, 'r', 1, 1, 0, 'x')`,
      ).run();
      // A SECOND row, non-blocking and non-declaration-origin, purely so the CHECK-enforcement
      // assertion below tests the CIRCLE clause in isolation — attempting the same write against
      // "ghost-concept" would ALSO trip the pre-existing severity/origin CHECK (blocking requires
      // declaration origin), since that row's origin is already 'declaration'.
      legacy.prepare(
        `INSERT INTO rule_bindings (concept_id, stage_id, severity, scope, model_tag, origin, declared_by,
                                    reason, created_at, sync_updated_at, sync_revision, sync_writer)
         VALUES ('check-test-row', (SELECT id FROM stages LIMIT 1), 'advisory', 'domain', NULL, 'projection', NULL, NULL, 1, 1, 0, 'x')`,
      ).run();
      legacy.close();
    }

    // THE UPGRADE: an ordinary open with the CURRENT build. Pre-fix, this line itself threw
    // "no such column: circle" — the index sat ahead of the column that creates it.
    const upgraded = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });

    const postUpgrade = raw(upgraded)
      .prepare(`SELECT concept_id, severity, circle FROM rule_bindings ORDER BY concept_id`)
      .all() as Array<{ concept_id: string; severity: string; circle: string | null }>;
    // Every real binding backfilled to its concept's CURRENT circle — "alpha" and "beta" unmoved,
    // "gamma" (the one that moved pre-upgrade) following the MOVE, not the circle it was declared
    // under. The dangling "ghost-concept" row has no concept to resolve against: left NULL, exactly
    // as the backfill's own WHERE clause documents.
    for (const row of preDowngrade) {
      const after = postUpgrade.find((r) => r.concept_id === row.concept_id);
      const conceptCircle = (raw(upgraded).prepare(`SELECT circle FROM concepts WHERE id = ?`).get(row.concept_id) as { circle: string }).circle;
      expect(after?.circle, row.concept_id).toBe(conceptCircle);
    }
    expect(postUpgrade.find((r) => r.concept_id === "ghost-concept")?.circle).toBeNull();

    // Gate delivery actually works post-upgrade, in every circle involved, including the moved one.
    expect(upgraded.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: "alpha" }).rules).toHaveLength(1);
    expect(upgraded.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: "gamma" }).rules).toHaveLength(1);
    expect(upgraded.gate({ actionContext: "Bash:npm install", circle: "beta" }).rules).toHaveLength(1);

    // The CHECK constraint the guarded ALTER carried is actually enforced on the upgraded table —
    // not merely present in the DDL text. 'projection' rather than 'correction' (review fix — Codex
    // round 3, item 2a widened the CHECK to accept 'correction' too, for a governed successor
    // inheriting breadth — 'projection' stays outside that widened set, so this still proves the
    // CHECK rejects an origin with no legitimate claim to '*' at all).
    expect(() =>
      raw(upgraded).prepare(`UPDATE rule_bindings SET circle = '*' WHERE concept_id = 'check-test-row'`).run(),
    ).toThrow(/CHECK constraint failed/);

    // IDEMPOTENT: a second createGateSchema against the already-upgraded table changes nothing and
    // does not throw (the guarded ALTER's own "duplicate column name" catch).
    expect(() => createGateSchema((upgraded as unknown as { db: StoragePort }).db)).not.toThrow();
    const secondPass = raw(upgraded).prepare(`SELECT concept_id, circle FROM rule_bindings ORDER BY concept_id`).all();
    expect(secondPass).toEqual(postUpgrade.map(({ concept_id, circle }) => ({ concept_id, circle })));
    upgraded.close();

    // TWO MIGRATORS RACING: a fresh pre-breadth file, two live connections, both running
    // createGateSchema without coordinating — the supported MCP+CLI multi-process topology
    // storage.ts's WAL + busy_timeout setup exists for. Both must converge on the SAME backfilled
    // state; neither may throw past the guarded ALTER's own duplicate-column catch.
    const raceDir = mkTmp();
    const racePath = join(raceDir, "race.db");
    const seedForRace = new MonetCore(racePath, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
    await seedForRace.store("Prefer npm ci.", {
      circle: "beta", kind: "rule", rule: { stage: "npm install", instance: "Bash:npm install", ...AGENT_RULE },
    });
    seedForRace.close();
    downgradeToPreBreadthSchema(racePath);

    const portA = new BetterSqlitePort(racePath);
    const portB = new BetterSqlitePort(racePath);
    expect(() => createGateSchema(portA)).not.toThrow();
    expect(() => createGateSchema(portB)).not.toThrow();
    const raceRows = portA.prepare(`SELECT concept_id, circle FROM rule_bindings`).all() as Array<{ concept_id: string; circle: string }>;
    expect(raceRows).toHaveLength(1);
    expect(raceRows[0]!.circle).toBe("beta");
    portA.close();
    portB.close();
  });

  it("bumps the generation exactly once for a backfill that actually changes delivery, and not at all once there is nothing left to backfill (minor m3)", async () => {
    const dir = mkTmp();
    const path = join(dir, "store2.db");
    const built = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
    await built.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking",
      reason: "there is no undo", ...AGENT_RULE,
    });
    built.close();
    downgradeToPreBreadthSchema(path);

    const port = new BetterSqlitePort(path);
    const genBefore = gateGeneration(port);
    createGateSchema(port); // the guarded ALTER, plus a real backfill (one row: NULL -> 'default')
    const genAfterBackfill = gateGeneration(port);
    expect(genAfterBackfill).toBeGreaterThan(genBefore);

    createGateSchema(port); // idempotent: the ALTER no-ops, and there is nothing left to backfill
    expect(gateGeneration(port)).toBe(genAfterBackfill);
    port.close();
  });

  /**
   * LEGACY '*' CIRCLES (Codex round 1, item 4). 1.3.1 — RELEASED, predating breadth entirely —
   * accepted any circle name a caller supplied, so a real store may hold concepts whose `circle`
   * column is the literal string `*`. Left alone, those concepts are either STRANDED (every
   * circle-minting surface now refuses `*`) or, worse, SEMANTICALLY REINTERPRETED as global breadth
   * the moment a rule is ever bound to one. `createGateSchema`'s migration seam renames them to
   * LEGACY_STAR_CIRCLE before the backfill runs, so neither failure mode is reachable.
   */
  it("a pre-breadth store with concepts in a circle literally named '*' upgrades cleanly — they land in legacy-star, remain fully searchable, and the backfill runs clean afterward (Codex round 1, item 4)", async () => {
    const dir = mkTmp();
    const path = join(dir, "legacy-star.db");
    const built = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
    const legacyFact = await built.store("A fact filed under 1.3.1's arbitrary circle-name freedom.", {
      circle: "an-ordinary-circle", kind: "fact",
    });
    built.close();

    // Simulate 1.3.1 directly: hand-write the circle column to the literal string '*'. No current
    // API can produce this any more — every minting surface refuses it — which is exactly why this
    // row can only be simulated, not created honestly, on this build.
    const legacy = new Database(path);
    legacy.prepare(`UPDATE concepts SET circle = '*' WHERE id = ?`).run(legacyFact.conceptId);
    legacy.close();

    // THE UPGRADE. Pre-fix, this concept stayed named '*' forever — stranded from every future
    // minting surface, and one accidental declare() away from being reinterpreted as breadth.
    const upgraded = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
    const migrated = raw(upgraded).prepare(`SELECT circle FROM concepts WHERE id = ?`).get(legacyFact.conceptId) as { circle: string };
    expect(migrated.circle).toBe(LEGACY_STAR_CIRCLE);

    // Fully searchable and usable — not stranded — in its new, ordinary circle.
    expect((await upgraded.getConcept(legacyFact.conceptId))?.title).toContain("1.3.1's arbitrary circle-name freedom");
    expect(upgraded.overview(LEGACY_STAR_CIRCLE).counts.concepts).toBe(1);

    // Surfaced in curation attention (MemoryOverview.legacyStarConcepts), store-wide, from ANY
    // circle's overview() — not merely visible to someone who already knows to look in legacy-star.
    expect(upgraded.overview("an-ordinary-circle").legacyStarConcepts).toBe(1);

    // The backfill ran clean afterward: opening at all (a fresh MonetCore always runs
    // createGateSchema's full sequence — rename, guarded ALTER, backfill, index) completed without
    // throwing, and an ordinary gate query in the new circle is a plain, correct miss.
    expect(upgraded.gate({ actionContext: "Bash:anything", circle: LEGACY_STAR_CIRCLE }).silence).toBe(true);
    upgraded.close();
  });

  it("a binding-carrying dev-main-shaped store — rule_bindings exists, no circle column yet — with a '*' concept ALSO migrates without tripping the CHECK, for both a blocking/declaration and an advisory/correction binding (Codex round 1, item 4)", async () => {
    const dir = mkTmp();
    const path = join(dir, "dev-main-legacy-star.db");
    const built = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
    // BLOCKING/DECLARATION — the "silently reinterpreted as breadth" risk: the CHECK
    // (circle != '*' OR origin = 'declaration') would NOT reject this combination, so an unfixed
    // backfill copying '*' straight onto it would succeed and mint an ACCIDENTAL global deny.
    const deny = await built.declare({
      circle: "an-ordinary-circle", species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    // ADVISORY/CORRECTION — the "crashes the backfill outright" risk: this CHECK combination WOULD
    // be rejected, so an unfixed backfill copying '*' onto it would throw mid-migration.
    const advisory = await built.store("Confirm before deleting.", {
      circle: "an-ordinary-circle", kind: "rule", rule: { stage: "rm -rf", ...AGENT_RULE },
    });
    built.close();

    downgradeToPreBreadthSchema(path); // strips rule_bindings.circle — the pre-breadth shape

    const legacy = new Database(path);
    legacy.prepare(`UPDATE concepts SET circle = '*' WHERE id IN (?, ?)`).run(deny.conceptId, advisory.conceptId);
    legacy.close();

    // THE UPGRADE. Neither failure mode is reachable: the rename lands before the backfill ever
    // reads `concepts.circle`, so the backfill never sees '*' at all.
    const upgraded = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
    for (const [id, expectedOrigin] of [[deny.conceptId, "declaration"], [advisory.conceptId, "correction"]] as const) {
      const conceptRow = raw(upgraded).prepare(`SELECT circle FROM concepts WHERE id = ?`).get(id) as { circle: string };
      const bindingRow = raw(upgraded).prepare(`SELECT circle, origin FROM rule_bindings WHERE concept_id = ?`).get(id) as { circle: string; origin: string };
      expect(conceptRow.circle, id).toBe(LEGACY_STAR_CIRCLE);
      expect(bindingRow.circle, id).toBe(LEGACY_STAR_CIRCLE); // NEVER '*' — never silently breadth
      expect(bindingRow.origin, id).toBe(expectedOrigin); // unchanged — this was never a breadth mint
    }
    expect(upgraded.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: LEGACY_STAR_CIRCLE }).rules.map((r) => r.conceptId))
      .toEqual([deny.conceptId, advisory.conceptId]);
    // ...and it never fires as though either were global.
    expect(upgraded.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: "some-other-circle-entirely" }).rules).toEqual([]);
    upgraded.close();
  });

  /**
   * 'legacy-star' CAN COLLIDE WITH A REAL USER CIRCLE (Codex round 2, item 3). A user who already
   * has a circle named exactly "legacy-star" — coincidence, or a previous migration on a COPY of
   * this store — must not have their content silently merged with whatever the CURRENT migration is
   * moving: that is a silent namespace merge, indistinguishable from data loss until someone notices
   * unrelated concepts mixed together.
   */
  it("probes for an unused destination when 'legacy-star' itself is already a real circle — advances to 'legacy-star-2' (Codex round 2, item 3)", async () => {
    const dir = mkTmp();
    const path = join(dir, "legacy-star-collision.db");
    const built = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
    // A real user circle already named exactly "legacy-star" — coincidence, unrelated to any
    // migration.
    const userOwned = await built.store("A concept a user filed under a circle named 'legacy-star' on purpose.", {
      circle: LEGACY_STAR_CIRCLE, kind: "fact",
    });
    const legacyFact = await built.store("A 1.3.1-era fact.", { circle: "an-ordinary-circle", kind: "fact" });
    built.close();

    const legacy = new Database(path);
    legacy.prepare(`UPDATE concepts SET circle = '*' WHERE id = ?`).run(legacyFact.conceptId);
    legacy.close();

    const upgraded = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
    const migratedRow = raw(upgraded).prepare(`SELECT circle FROM concepts WHERE id = ?`).get(legacyFact.conceptId) as { circle: string };
    // NOT "legacy-star" — that name was already taken — but the NEXT unused numbered variant.
    expect(migratedRow.circle).toBe(`${LEGACY_STAR_CIRCLE}-2`);
    // The pre-existing user circle is completely undisturbed: still exactly one concept, still its
    // own — the collision this test exists to prevent, avoided.
    const userRow = raw(upgraded).prepare(`SELECT circle FROM concepts WHERE id = ?`).get(userOwned.conceptId) as { circle: string };
    expect(userRow.circle).toBe(LEGACY_STAR_CIRCLE);
    expect(upgraded.overview(LEGACY_STAR_CIRCLE).counts.concepts).toBe(1);
    expect(upgraded.overview(`${LEGACY_STAR_CIRCLE}-2`).counts.concepts).toBe(1);
    // The store-wide count (MemoryOverview.legacyStarConcepts) sees BOTH populations under the
    // family GLOB, even though only one of them is actually a migration artifact — the field's own
    // documented shape ("counts the family, not a specific name") accepted that imprecision
    // deliberately; see its own comment.
    expect(upgraded.overview("an-ordinary-circle").legacyStarConcepts).toBe(2);
    upgraded.close();
  });

  it("probes for an unused destination when 'legacy-star' is already taken by a registered SOURCE with zero concepts of its own — advances to 'legacy-star-2' (Codex round 5, item 2)", async () => {
    const dir = mkTmp();
    const path = join(dir, "legacy-star-source-collision.db");
    const built = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
    // A real source registered at exactly "legacy-star" on purpose — coincidence, unrelated to any
    // migration — that has never ingested anything, so NO concept anywhere names this circle either.
    const userOwnedSource = built.createSource({
      id: "user-owned-source", type: "repo-md", name: "User's own docs",
      repositoryIdentity: "github.com/Acme/UserOwned.git/", localPath: join(dir, "repo-a"),
      circle: LEGACY_STAR_CIRCLE,
      include: ["**/*.md"], exclude: [],
      access: { allowedCallerIds: ["caller-a"], allowedProjectIds: ["project-a"] },
      writeBack: "none", refresh: { mode: "manual" },
    });
    // A SECOND, unrelated source — about to be discovered living in circle '*' after the downgrade
    // below, exactly like a genuine 1.3.1-era registration.
    const legacySource = built.createSource({
      id: "legacy-source", type: "repo-md", name: "Legacy docs",
      repositoryIdentity: "github.com/Acme/Legacy.git/", localPath: join(dir, "repo-b"),
      circle: "an-ordinary-circle",
      include: ["**/*.md"], exclude: [],
      access: { allowedCallerIds: ["caller-a"], allowedProjectIds: ["project-a"] },
      writeBack: "none", refresh: { mode: "manual" },
    });
    built.close();

    const legacy = new Database(path);
    legacy.prepare(`UPDATE knowledge_sources SET circle = '*' WHERE id = ?`).run(legacySource.id);
    // Confirm the premise directly: NOTHING in concepts or circle_aliases names either circle — the
    // OLD probe's own two checks would both come back empty, exactly why it missed this.
    expect(legacy.prepare(`SELECT 1 FROM concepts WHERE circle IN ('*', ?)`).get(LEGACY_STAR_CIRCLE)).toBeUndefined();
    expect(legacy.prepare(`SELECT 1 FROM circle_aliases WHERE from_name IN ('*', ?) OR to_name IN ('*', ?)`).get(LEGACY_STAR_CIRCLE, LEGACY_STAR_CIRCLE)).toBeUndefined();
    legacy.close();

    const upgraded = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
    // NOT 'legacy-star' — that name was already taken by the first source — but the NEXT unused
    // numbered variant.
    expect(upgraded.getSource(legacySource.id)?.circle).toBe(`${LEGACY_STAR_CIRCLE}-2`);
    // The pre-existing user-owned source is completely undisturbed — the collision this test exists
    // to prevent, avoided.
    expect(upgraded.getSource(userOwnedSource.id)?.circle).toBe(LEGACY_STAR_CIRCLE);
    upgraded.close();
  });

  /**
   * ROUND 2's OWN SEAM REPRODUCED B1's CLASS ONE LAYER UP (Codex round 3, item 1). A genuine
   * pre-gate 1.3.1 store has NO gate tables at all — not just no `circle` column, no `stages`,
   * `rule_bindings`, `gate_events`, or `gate_meta` whatsoever. Round 2 ran the legacy-star migration
   * BEFORE `createGateSchema` (which creates `gate_meta`), so its own `bumpGateGeneration` call
   * threw "no such table: gate_meta" — AFTER the concept had already moved (no explicit transaction
   * wraps `moveCircleScopedTables`) — aborting construction on the FIRST open and succeeding only on
   * a retry, because the second attempt found nothing left to migrate. This is the exact scenario:
   * no DROP-and-rebuild-the-legacy-DDL fixture (nothing to preserve — this store never had gate
   * tables to begin with), just the four gate tables genuinely absent.
   */
  it("a pre-gate store — no gate tables at all — with a '*' circle opens successfully on the FIRST attempt (Codex round 3, item 1)", async () => {
    const dir = mkTmp();
    const path = join(dir, "pregate-star.db");
    const built = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
    const legacyFact = await built.store("A fact from before gates existed.", {
      circle: "an-ordinary-circle", kind: "fact",
    });
    built.close();

    // Simulate a GENUINE pre-gate 1.3.1 store: every gate table absent, not merely missing a column.
    const legacy = new Database(path);
    legacy.exec(`DROP INDEX IF EXISTS idx_rule_bindings_circle`);
    // trg_rule_bindings_backfill_circle (round 5, ON rule_bindings) is auto-dropped by the DROP
    // TABLE rule_bindings below (a trigger dies with the table it is registered on). trg_rule_
    // bindings_follow_concept_circle (round 7, item 2, ON concepts) is NOT — concepts is never
    // touched here — so it survives, unchanged, still referencing rule_bindings, and throws "no such
    // table: rule_bindings" the moment the UPDATE below fires it. A genuine pre-gate store has
    // neither trigger; dropped explicitly to actually reach that state.
    legacy.exec(`DROP TRIGGER IF EXISTS trg_rule_bindings_follow_concept_circle`);
    legacy.exec(`DROP TABLE IF EXISTS rule_bindings`);
    legacy.exec(`DROP TABLE IF EXISTS stages`);
    legacy.exec(`DROP TABLE IF EXISTS gate_events`);
    legacy.exec(`DROP TABLE IF EXISTS gate_meta`);
    legacy.prepare(`UPDATE concepts SET circle = '*' WHERE id = ?`).run(legacyFact.conceptId);
    legacy.close();

    // THE FIRST ATTEMPT. Pre-fix, this line itself threw "no such table: gate_meta".
    const upgraded = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });

    // Migration completed: the concept moved.
    const migratedRow = raw(upgraded).prepare(`SELECT circle FROM concepts WHERE id = ?`).get(legacyFact.conceptId) as { circle: string };
    expect(migratedRow.circle).toBe(LEGACY_STAR_CIRCLE);
    // Every gate table now exists, backfill included — a fresh rule declared now works end to end.
    const rule = await upgraded.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo",
      scope: "domain",
    });
    if (rule.species !== "rule") throw new Error("unreachable");
    expect(upgraded.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules.map((r) => r.conceptId)).toEqual([rule.conceptId]);
    // Generation is sane: positive, and advances on a further real mutation.
    const genAfterOpen = upgraded.sidecarGeneration();
    expect(genAfterOpen).toBeGreaterThan(0);
    await upgraded.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Prefer npm ci.", severity: "advisory", scope: "domain",
    });
    expect(upgraded.sidecarGeneration()).toBeGreaterThan(genAfterOpen);
    upgraded.close();
  });

  /**
   * A genuinely pre-v8 store has the sync_meta table but not necessarily its singleton row yet:
   * constructor order reaches the legacy-star migration before initSyncIdentity. The migration must
   * therefore use nextSyncTimestampOrNow rather than dereference a missing persisted clock.
   */
  it("a pre-v8 store — sync_meta exists, but its singleton row does not yet — with a '*' circle opens successfully on the FIRST attempt (Codex round 4, item 1)", async () => {
    const dir = mkTmp();
    const path = join(dir, "pre-v8-no-singleton.db");
    const built = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
    const legacyFact = await built.store("A fact stored before breadth existed.", {
      circle: "an-ordinary-circle", kind: "fact",
    });
    built.close();

    const legacy = new Database(path);
    legacy.prepare(`UPDATE concepts SET circle = '*' WHERE id = ?`).run(legacyFact.conceptId);
    legacy.prepare(`DELETE FROM sync_meta WHERE singleton = 1`).run();
    expect(legacy.prepare(`SELECT 1 FROM sync_meta WHERE singleton = 1`).get()).toBeUndefined();
    legacy.close();

    const upgraded = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
    await upgraded.ensureEmbedderPin();

    const migratedRow = raw(upgraded).prepare(`SELECT circle FROM concepts WHERE id = ?`).get(legacyFact.conceptId) as { circle: string };
    expect(migratedRow.circle).toBe(LEGACY_STAR_CIRCLE);
    expect(raw(upgraded).prepare(`SELECT 1 FROM sync_meta WHERE singleton = 1`).get()).toBeDefined();
    expect(upgraded.sidecarGeneration()).toBeGreaterThan(0);
    const rule = await upgraded.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo",
      scope: "domain",
    });
    if (rule.species !== "rule") throw new Error("unreachable");
    expect(upgraded.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules.map((r) => r.conceptId)).toEqual([rule.conceptId]);
    upgraded.close();
  });

  /**
   * A REGISTERED SOURCE IS NOT EXEMPT FROM THE MOVE (Codex round 4, item 2). renameCircle's own guard
   * (assertNoRegisteredSourceCircleParticipants) refuses to ever rename a circle a registered source
   * participates in — "source circles are immutable registry identity" — but that is a policy for a
   * DISCRETIONARY rename a user chose to run, not a technical requirement: it does not, and could not,
   * apply to the legacy-star migration, which is mandatory and automatic. Left unfixed, a source
   * registered under a circle literally named '*' would keep succeeding at registration while every
   * ingestion into it threw forever at storeInternal's own concept guard — this test proves the whole
   * round-trip closes, registration through a REAL ingestion, not merely that a column value changed.
   */
  it("the legacy-star migration also moves a registered source's own circle, alongside its already-ingested concepts, and ingestion into it works afterward (Codex round 4, item 2)", async () => {
    const dir = mkTmp();
    const path = join(dir, "legacy-star-source.db");
    const built = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
    const source = built.createSource({
      id: "legacy-source", type: "repo-md", name: "Legacy docs",
      repositoryIdentity: "github.com/Acme/Legacy.git/", localPath: join(dir, "repo"),
      circle: "an-ordinary-circle",
      include: ["**/*.md"], exclude: [],
      access: { allowedCallerIds: ["caller-a"], allowedProjectIds: ["project-a"] },
      writeBack: "none", refresh: { mode: "manual" },
    });
    const ingested = await built.storeSource("Legacy content ingested before the upgrade.", {
      circle: "an-ordinary-circle", sourceRefs: [`source://${source.id}/README.md`],
    });
    built.close();

    // Simulate the legacy shape: BOTH the source's own registry row and a concept it did not (yet)
    // touch already lived in '*'.
    const legacy = new Database(path);
    legacy.prepare(`UPDATE knowledge_sources SET circle = '*' WHERE id = ?`).run(source.id);
    legacy.prepare(`UPDATE concepts SET circle = '*' WHERE circle = 'an-ordinary-circle'`).run();
    legacy.close();

    const upgraded = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });

    // The registry row followed the concepts it owns, not left behind under the now-reserved name.
    const migratedSource = upgraded.getSource(source.id);
    expect(migratedSource?.circle).toBe(LEGACY_STAR_CIRCLE);
    const migratedConcept = raw(upgraded).prepare(`SELECT circle FROM concepts WHERE id = ?`).get(ingested.conceptId) as { circle: string };
    expect(migratedConcept.circle).toBe(LEGACY_STAR_CIRCLE);

    // THE ROUND-TRIP: a fresh ingestion into the migrated source succeeds — pre-fix, this would
    // throw at storeInternal's own concept guard forever, because the source's OWN registered circle
    // (still '*') fed straight into this call's `circle` option.
    const secondIngest = await upgraded.storeSource("Content ingested after the upgrade.", {
      circle: migratedSource!.circle, sourceRefs: [`source://${source.id}/CHANGELOG.md`],
    });
    // Raw SQL, not getConcept(): a source-connector-owned concept is authorization-fenced there
    // (isConnectorOwnedRow + authorizedSourceProjection) — unrelated to this item, just the same
    // direct-row-check convention migratedConcept above already uses.
    const secondIngestRow = raw(upgraded).prepare(`SELECT circle FROM concepts WHERE id = ?`).get(secondIngest.conceptId) as { circle: string };
    expect(secondIngestRow.circle).toBe(LEGACY_STAR_CIRCLE);
    upgraded.close();
  });

  it("moves a registered source's circle even when NO concept currently shares circle '*' at all — a source cannot be the only thing stranded (Codex round 4, item 2)", async () => {
    const dir = mkTmp();
    const path = join(dir, "legacy-star-source-only.db");
    const built = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
    const source = built.createSource({
      id: "orphaned-source", type: "repo-md", name: "Orphaned docs",
      repositoryIdentity: "github.com/Acme/Orphaned.git/", localPath: join(dir, "repo"),
      circle: "an-ordinary-circle",
      include: ["**/*.md"], exclude: [],
      access: { allowedCallerIds: ["caller-a"], allowedProjectIds: ["project-a"] },
      writeBack: "none", refresh: { mode: "manual" },
    });
    built.close();

    // ONLY the source's registry row is in '*' — it has never ingested anything, so there is no
    // concept anywhere in this store's circle '*' at all. hasLegacyStar (concepts.circle = '*')
    // would be false; gating the whole move on it alone would strand this source forever.
    const legacy = new Database(path);
    legacy.prepare(`UPDATE knowledge_sources SET circle = '*' WHERE id = ?`).run(source.id);
    expect(legacy.prepare(`SELECT 1 FROM concepts WHERE circle = '*'`).get()).toBeUndefined();
    legacy.close();

    const upgraded = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
    expect(upgraded.getSource(source.id)?.circle).toBe(LEGACY_STAR_CIRCLE);
    upgraded.close();
  });

  /**
   * A CIRCLE POPULATED ONLY BY NORMATIVE ROWS CAN BE THE ONLY THING STRANDED TOO (Codex round 9,
   * item 3). Same shape as the source-only test just above, for lifecycle_edges/ratifications
   * instead of knowledge_sources: `chooseLegacyStarDestination`'s own collision probe already
   * checked both tables (round 5's own extension, cited in that method's own comment); the
   * TRIGGER-CONDITION set here never gained the matching check, so a store whose ONLY '*'
   * population was a ratification row hit this method every open and never migrated it — stranded
   * exactly as permanently as the pre-round-4 source case was.
   */
  it("moves a normative-only circle even when NO concept, source, or alias shares circle '*' at all — a ratification row cannot be the only thing stranded (Codex round 9, item 3)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const dir = mkTmp();
      const path = join(dir, "legacy-star-normative-only.db");
      const built = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
      built.close();

      const legacy = new Database(path);
      const now = Date.now();
      // subject_concept_id carries no foreign key (lifecycle-edges.ts's own schema) — a ratification
      // outliving the concept it once ratified is exactly the doctrine this item's own fix is about,
      // so an arbitrary id here is the honest shape, not a shortcut.
      legacy.prepare(
        `INSERT INTO ratifications (id, subject_concept_id, verdict, packet, ratified_by, circle, created_at, sync_updated_at)
         VALUES ('rat-1', 'some-concept-elsewhere', 'approve', NULL, 'a-human', '*', ?, ?)`,
      ).run(now, now);
      // ONLY the ratification is in '*' — no concept, no source, no alias anywhere names it, so
      // hasLegacyStar/hasLegacyStarSource/staleStarSource/staleStarTarget are all false; only
      // hasLegacyStarNormative can be what triggers the migration here.
      expect(legacy.prepare(`SELECT 1 FROM concepts WHERE circle = '*'`).get()).toBeUndefined();
      expect(legacy.prepare(`SELECT 1 FROM knowledge_sources WHERE circle = '*'`).get()).toBeUndefined();
      expect(legacy.prepare(`SELECT 1 FROM circle_aliases WHERE from_name = '*' OR to_name = '*'`).get()).toBeUndefined();
      legacy.close();

      const upgraded = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });

      // MIGRATION FIRED: the row landed at the destination, not stranded at '*' forever.
      const moved = raw(upgraded).prepare(`SELECT circle FROM ratifications WHERE id = 'rat-1'`).get() as { circle: string };
      expect(moved.circle).toBe(LEGACY_STAR_CIRCLE);

      // DISCLOSURE COUNTS IT — the disclosure previously only ever mentioned concepts and sources;
      // extended per this item's own ask (see migrateLegacyStarCircle's own comment for what changed).
      const normativeDisclosure = consoleErrorSpy.mock.calls.map((args) => String(args[0])).find((msg) => msg.includes("normative history row(s)"));
      expect(normativeDisclosure).toMatch(/1 normative history row\(s\)/);
      expect(normativeDisclosure).toMatch(new RegExp(`moved to circle '${LEGACY_STAR_CIRCLE}'`));

      upgraded.close();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  /**
   * LEGACY circle_aliases ROWS NAMING '*' ALSO SURVIVE UNTREATED WITHOUT THIS FIX (Codex round 4,
   * item 4). Verified against resolveCircle's actual single-hop mechanics and DOOR 13 item 8's
   * existing graft refusal before implementing (not assumed): a `to_name = '*'` row resolves an
   * ordinary circle name INTO the breadth marker — RULE_LIVENESS_WHERE's own `(b.circle = ? OR
   * b.circle = '*')` degenerates to matching ONLY global rules when `?` is bound to '*' itself — so
   * gate queries through the alias would silently lose every local rule the resolved circle actually
   * carries; a `from_name = '*'` row breaks resolveCircle('*') staying the passthrough every
   * circle-minting guard assumes. The ruling: `to_name = '*'` rows are REPOINTED to the migration
   * destination (queries through the original name must land where the content actually went); `from_name
   * = '*'` rows are DELETED (that namespace was already fully vacated by the rename the row recorded,
   * and '*' must stay unresolvable). Both directions, in one store, in one migration pass.
   */
  it("legacy circle_aliases rows naming '*' on either side are cleaned during migration: the TO side repoints to the destination and delivers the migrated LOCAL rule (not just the global one), the FROM side is deleted and '*' stays unresolvable, and disclosure counts both (Codex round 4, item 4)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const dir = mkTmp();
      const path = join(dir, "legacy-star-aliases.db");
      const built = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
      // A LOCAL rule under "project" — this is what `project -> *` must still deliver after the fix,
      // proving the resolution lands on the migrated destination rather than degenerating to
      // global-only.
      const localRule = await built.declare({
        circle: "project", species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
        content: "Confirm the registry before installing.", severity: "advisory", scope: "domain",
      });
      if (localRule.species !== "rule") throw new Error("unreachable");
      // A GENUINELY GLOBAL rule sharing the same stage — the control that makes "delivers the local
      // rule too" distinguishable from "delivers only global rules regardless".
      const globalRule = await built.declare({
        circle: BREADTH_CIRCLE, species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
        content: "Never install without a lockfile.", severity: "advisory", scope: "domain",
      });
      if (globalRule.species !== "rule") throw new Error("unreachable");
      built.close();

      const legacy = new Database(path);
      // Simulate the LOCAL rule's concept having been renamed into '*' long ago (1.3.1-legal).
      legacy.prepare(`UPDATE concepts SET circle = '*' WHERE id = ?`).run(localRule.conceptId);
      // DANGLING (NULL), not literally '*' — matching round 1's own proven-safe shape ("a
      // binding-carrying dev-main-shaped store", above): migrateGateColumns' backfill only fills
      // `circle IS NULL` rows, from the CONCEPT's circle at backfill time, which by then is already
      // `legacy-star` (concept moves BEFORE the backfill runs, per the (a)->(b)->(c) ordering this
      // whole review series built). Setting this to a literal '*' here instead would simulate a
      // DIFFERENT, narrower scenario this test is not about — a binding already backfilled to '*' by
      // an even earlier, intermediate build that predates round 1's own fix — which the backfill's
      // `WHERE circle IS NULL` guard would then skip entirely, leaving it stuck at '*' forever; a
      // real gap, but a separate one from item 4's own circle_aliases concern, out of THIS round's
      // scope and disclosed separately rather than conflated into this fixture.
      legacy.prepare(`UPDATE rule_bindings SET circle = NULL WHERE concept_id = ?`).run(localRule.conceptId);
      const now = Date.now();
      // TO side: "project" was renamed into '*' — a legal 1.3.1 rename target, before '*' was reserved.
      legacy.prepare(
        `INSERT INTO circle_aliases (from_name, to_name, status, created_at, updated_at, sync_revision, sync_writer)
         VALUES ('project', '*', 'active', ?, ?, 1, 'machine-a')`,
      ).run(now, now);
      // FROM side: an UNRELATED, older rename — '*' itself was once renamed away to a circle this
      // store no longer has any other record of. Independent row (different from_name), same table.
      legacy.prepare(
        `INSERT INTO circle_aliases (from_name, to_name, status, created_at, updated_at, sync_revision, sync_writer)
         VALUES ('*', 'some-ancient-destination-nobody-remembers', 'active', ?, ?, 1, 'machine-a')`,
      ).run(now, now);
      legacy.close();

      const upgraded = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });

      // FROM side: deleted. '*' stays unresolvable — the single-hop passthrough every circle-minting
      // guard assumes is restored, not merely "no longer obviously broken".
      expect(raw(upgraded).prepare(`SELECT 1 FROM circle_aliases WHERE from_name = '*'`).get()).toBeUndefined();
      expect(upgraded.resolveCircleName(BREADTH_CIRCLE)).toBe(BREADTH_CIRCLE);

      // TO side: repointed to the ACTUAL destination, not left dangling and not simply removed.
      const projectAlias = raw(upgraded).prepare(`SELECT to_name FROM circle_aliases WHERE from_name = 'project'`).get() as { to_name: string };
      expect(projectAlias.to_name).toBe(LEGACY_STAR_CIRCLE);

      // THE PAYOFF: querying through "project" delivers BOTH the migrated local rule and the global
      // one — union, not global-only. A second, untouched circle proves the global rule alone is not
      // what is doing the work here (it would fire there too, with or without this fix).
      expect(upgraded.gate({ actionContext: "Bash:npm install", circle: "project" }).rules.map((r) => r.conceptId).sort())
        .toEqual([globalRule.conceptId, localRule.conceptId].sort());
      expect(upgraded.gate({ actionContext: "Bash:npm install", circle: "a-circle-nothing-else-touches" }).rules.map((r) => r.conceptId))
        .toEqual([globalRule.conceptId]);

      // DISCLOSURE counts both cleaned rows (1 deleted + 1 repointed = 2).
      const aliasDisclosure = consoleErrorSpy.mock.calls.map((args) => String(args[0])).find((msg) => msg.includes("circle_aliases row(s)"));
      expect(aliasDisclosure).toMatch(/cleaned 2 legacy circle_aliases row\(s\)/);
      expect(aliasDisclosure).toMatch(/1 removed/);
      expect(aliasDisclosure).toMatch(new RegExp(`1 repointed to '${LEGACY_STAR_CIRCLE}'`));

      upgraded.close();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  /**
   * A LIVE COMPATIBILITY TRIGGER, NOT ONLY A RESTART-TIME BACKFILL (Codex round 5, item 4, P1). "This
   * machine runs mixed builds against one store today": an OLDER build's own `bindRule`-equivalent
   * INSERT was compiled before the `circle` column existed, so it omits the column entirely — a raw
   * INSERT landing `circle = NULL`, invisible to RULE_LIVENESS_WHERE's `b.circle = ?` filter (NULL
   * matches nothing, ever), including a FRESH DENY, until SOME process eventually restarts and reruns
   * the backfill. A schema-level TRIGGER fires on ANY connection's INSERT regardless of which build
   * issued it — closing the live gap between "an old build wrote this" and "the next restart notices".
   */
  it("a raw pre-breadth-shaped INSERT (old-build shape, no circle reference at all) on an upgraded store carries the concept's circle immediately, at insert time — no restart required (Codex round 5, item 4)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const oldBuildsRule = await c.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Confirm the lockfile before installing.", severity: "advisory", scope: "domain",
      circle: "project",
    });
    if (oldBuildsRule.species !== "rule") throw new Error("unreachable");
    const stageId = c.ruleBinding(oldBuildsRule.conceptId)!.stage_id;

    // SIMULATE: this binding arrived via an OLD BUILD's own bindRule-equivalent instead — the
    // CONCEPT (kind='rule', active, RULE_LIVENESS_WHERE's own other requirements) was declared
    // normally above and stays untouched; only the BINDING is replaced with the exact pre-breadth
    // column shape LEGACY_RULE_BINDINGS_DDL declares (no `circle` anywhere in the INSERT) — the one
    // column this fix is about.
    raw(c).prepare(`DELETE FROM rule_bindings WHERE concept_id = ?`).run(oldBuildsRule.conceptId);
    raw(c).prepare(
      `INSERT INTO rule_bindings
         (concept_id, stage_id, severity, scope, model_tag, origin, declared_by, reason,
          created_at, sync_updated_at, sync_revision, sync_writer)
       VALUES (?, ?, 'advisory', 'domain', NULL, 'declaration', NULL, 'an old-build reason', ?, ?, 0, 'old-build')`,
    ).run(oldBuildsRule.conceptId, stageId, Date.now(), Date.now());

    // IMMEDIATELY — no reopen, no restart, no call to migrateGateColumns again. The trigger fired
    // synchronously inside the INSERT statement above, before it even returned.
    const landed = raw(c).prepare(`SELECT circle FROM rule_bindings WHERE concept_id = ?`).get(oldBuildsRule.conceptId) as { circle: string | null };
    expect(landed.circle).toBe("project");
    // And it actually delivers, live, in the SAME process that never restarted.
    expect(c.gate({ actionContext: "Bash:npm install", circle: "project" }).rules.map((r) => r.conceptId))
      .toContain(oldBuildsRule.conceptId);
    c.close();
  });

  /**
   * THE DANGLING COMPOSITION (Codex round 5, item 4): this trigger and BLOCKER B3 (engine.ts) heal
   * the SAME symptom at two DIFFERENT moments and must not fight over the row in between. A binding
   * whose concept has not landed on this device AT ALL yet — the sync-specific dangling-then-live
   * gap — must stay genuinely NULL, not be resolved to a wrong guess, until the concept actually
   * arrives; this trigger's own UPDATE subquery evaluates to NULL when no matching concept exists
   * (a scalar subquery over zero rows), which is a real no-op, not a false resolution — verified
   * directly, not merely asserted from reading the SQL.
   */
  it("the dangling composition: a binding whose concept has not arrived stays NULL (this trigger's own no-op), and BLOCKER B3 heals it when the concept lands via graft — composing rather than fighting (Codex round 5, item 4)", async () => {
    const peer = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "peer" });
    // kind='rule' on the CONCEPT — RULE_LIVENESS_WHERE requires it (this module's own doc comment:
    // "active concept, kind='rule', not superseded"), so the concept side must satisfy it even
    // though its OWN binding (created here too) never crosses to the receiver — stripped below.
    const futureRule = await peer.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "A rule concept that has not arrived on the receiver yet.", severity: "advisory", scope: "domain",
      circle: "project",
    });
    if (futureRule.species !== "rule") throw new Error("unreachable");
    // Only the CONCEPT, deliberately — stripping ruleBindings isolates this test to BLOCKER B3's own
    // concepts-loop healing, uncontaminated by the ordinary graft rule_bindings write path (which
    // would ALSO resolve this correctly, but is not what this test is pinning).
    const conceptOnlyPayload = { ...peer.exportDelta(0), ruleBindings: [] };

    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const seed = await c.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Seed rule so a real stage exists on the receiver too.", severity: "advisory", scope: "domain",
    });
    if (seed.species !== "rule") throw new Error("unreachable");
    const stageId = c.ruleBinding(seed.conceptId)!.stage_id;

    // A DANGLING binding, inserted BEFORE the concept it names has ever landed on this receiver.
    raw(c).prepare(
      `INSERT INTO rule_bindings
         (concept_id, stage_id, severity, scope, model_tag, origin, declared_by, reason,
          created_at, sync_updated_at, sync_revision, sync_writer)
       VALUES (?, ?, 'advisory', 'domain', NULL, 'declaration', NULL, 'a reason', ?, ?, 0, 'peer')`,
    ).run(futureRule.conceptId, stageId, Date.now(), Date.now());
    expect(
      (raw(c).prepare(`SELECT circle FROM rule_bindings WHERE concept_id = ?`).get(futureRule.conceptId) as { circle: string | null }).circle,
    ).toBeNull();
    // Correctly invisible — a NULL circle matches no query's filter, live or offline.
    expect(c.gate({ actionContext: "Bash:npm install", circle: "project" }).rules.map((r) => r.conceptId))
      .not.toContain(futureRule.conceptId);

    // THE CONCEPT ARRIVES — via graft, BLOCKER B3's own trigger condition ("this concept landing IS
    // that binding's concept arriving: close the gap here, now, in the SAME transaction").
    c.graftRows(conceptOnlyPayload as never);
    const healed = raw(c).prepare(`SELECT circle FROM rule_bindings WHERE concept_id = ?`).get(futureRule.conceptId) as { circle: string | null };
    expect(healed.circle).toBe("project");
    expect(c.gate({ actionContext: "Bash:npm install", circle: "project" }).rules.map((r) => r.conceptId))
      .toContain(futureRule.conceptId);

    peer.close(); c.close();
  });

  /**
   * THE UPDATE SIDE OF THE COMPATIBILITY TRIGGER FAMILY (Codex round 7, item 2, P1). Round 5's own
   * trigger closes the gap for an old build MINTING a binding (INSERT); this one closes the
   * SYMMETRIC gap for an old build MOVING a concept that already has one — moveConcept/renameCircle's
   * pre-breadth code UPDATEs `concepts.circle` directly with no idea `rule_bindings.circle` needs to
   * follow, reopening the exact round-1, item-3 silent-divergence shape for any writer old enough to
   * predate the keep-in-step convention.
   */
  it("a raw old-build-shaped UPDATE of a concept's circle (no rule_bindings touch at all) — the binding follows immediately, at update time; a '*' binding stays '*', untouched (Codex round 7, item 2)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const localRule = await c.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Confirm the lockfile before installing.", severity: "advisory", scope: "domain",
      circle: "project",
    });
    if (localRule.species !== "rule") throw new Error("unreachable");
    const globalRule = await c.declare({
      circle: BREADTH_CIRCLE, species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Never install without a lockfile.", severity: "advisory", scope: "domain",
    });
    if (globalRule.species !== "rule") throw new Error("unreachable");

    // THE OLD BUILD'S OWN UPDATE — concepts.circle alone, exactly what moveConcept/renameCircle's
    // pre-keep-in-step code issues; no rule_bindings statement anywhere near it.
    raw(c).prepare(`UPDATE concepts SET circle = ? WHERE id = ?`).run("project-moved", localRule.conceptId);

    // IMMEDIATELY — no second statement, no reopen. The trigger fired synchronously inside the very
    // UPDATE above, before it even returned.
    const followed = raw(c).prepare(`SELECT circle FROM rule_bindings WHERE concept_id = ?`).get(localRule.conceptId) as { circle: string };
    expect(followed.circle).toBe("project-moved");
    expect(c.gate({ actionContext: "Bash:npm install", circle: "project-moved" }).rules.map((r) => r.conceptId))
      .toContain(localRule.conceptId);
    expect(c.gate({ actionContext: "Bash:npm install", circle: "project" }).rules.map((r) => r.conceptId))
      .not.toContain(localRule.conceptId);

    // A '*' BINDING STAYS '*' — the same old-build UPDATE, against the GLOBAL rule's own concept.
    // A global rule's reach is a property of the BINDING, independent of wherever its concept is
    // filed — re-aligning it here would silently narrow a global rule to local.
    raw(c).prepare(`UPDATE concepts SET circle = ? WHERE id = ?`).run("wherever-this-concept-ends-up", globalRule.conceptId);
    const stayedGlobal = raw(c).prepare(`SELECT circle FROM rule_bindings WHERE concept_id = ?`).get(globalRule.conceptId) as { circle: string };
    expect(stayedGlobal.circle).toBe(BREADTH_CIRCLE);
    expect(c.gate({ actionContext: "Bash:npm install", circle: "a-circle-nothing-else-touches" }).rules.map((r) => r.conceptId))
      .toContain(globalRule.conceptId);
    c.close();
  });

  /**
   * THE BACKFILL TRIGGER BUMPS THE GENERATION TOO (Codex round 7, item 3, P2). Round 5's own trigger
   * fixed the CIRCLE value; it never touched gate_meta, so an old build's own INSERT landed a live
   * rule the on-disk mirror's own stamped generation had no way to know was now behind. isSidecarStale
   * compares the file's own generation against gate_meta's current value — the bump is what makes
   * that comparison catch this case at all.
   */
  it("an old-build-shaped INSERT bumps gate_meta's generation too, and isSidecarStale reports the on-disk mirror stale (Codex round 7, item 3)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    const seed = await c.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Seed rule so a real stage exists to bind against.", severity: "advisory", scope: "domain",
    });
    if (seed.species !== "rule") throw new Error("unreachable");
    const stageId = c.ruleBinding(seed.conceptId)!.stage_id;
    // A fresh materialize so the ON-DISK file's own stamped generation is CURRENT before the probe —
    // isolates this test to what the trigger itself does, not to whatever staleness already existed.
    c.materializeGateMirror(path);
    expect(c.isSidecarStale().stale).toBe(false);
    const generationBefore = c.sidecarGeneration();

    const oldBuildsRule = await c.store("Confirm the target path first.", { circle: "project", kind: "fact" });
    // THE OLD BUILD'S OWN INSERT — the exact pre-circle-column column list, no circle anywhere in it.
    raw(c).prepare(
      `INSERT INTO rule_bindings
         (concept_id, stage_id, severity, scope, model_tag, origin, declared_by, reason,
          created_at, sync_updated_at, sync_revision, sync_writer)
       VALUES (?, ?, 'advisory', 'domain', NULL, 'declaration', NULL, 'an old-build reason', ?, ?, 0, 'old-build')`,
    ).run(oldBuildsRule.conceptId, stageId, Date.now(), Date.now());

    expect(c.sidecarGeneration()).toBeGreaterThan(generationBefore);
    // THE FILE ITSELF NEVER MOVED — an old build's own process has no JS hook to refresh it — so the
    // comparison now disagrees: exactly the honest-stale contract, not a silent-fresh lie.
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "behind" });
    c.close();
  });

  /**
   * THE UPDATE-SIDE TRIGGER BUMPS THE GENERATION TOO (Codex round 8, item 2, P2). The symmetric gap
   * to round 7, item 3's own fix on the INSERT trigger: round 7, item 2 fixed the CIRCLE value for an
   * old build's own concept move, but never touched gate_meta, so the move landed undetectably — the
   * on-disk mirror's own stamped generation had no way to know it was now behind.
   */
  it("an old-build-shaped UPDATE of a concept's circle (with a live binding) bumps gate_meta's generation too, and isSidecarStale reports the on-disk mirror stale (Codex round 8, item 2)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    const seed = await c.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Confirm the lockfile before installing.", severity: "advisory", scope: "domain",
      circle: "project",
    });
    if (seed.species !== "rule") throw new Error("unreachable");
    // A fresh materialize so the ON-DISK file's own stamped generation is CURRENT before the probe —
    // isolates this test to what the trigger itself does, not to whatever staleness already existed.
    c.materializeGateMirror(path);
    expect(c.isSidecarStale().stale).toBe(false);
    const generationBefore = c.sidecarGeneration();

    // THE OLD BUILD'S OWN UPDATE — concepts.circle alone, exactly what moveConcept/renameCircle's
    // pre-keep-in-step code issues; no rule_bindings statement anywhere near it (same shape as round
    // 7, item 2's own test above, here probing the generation side rather than the circle value).
    raw(c).prepare(`UPDATE concepts SET circle = ? WHERE id = ?`).run("project-moved", seed.conceptId);

    expect(c.sidecarGeneration()).toBeGreaterThan(generationBefore);
    // THE FILE ITSELF NEVER MOVED — an old build's own process has no JS hook to refresh it — so the
    // comparison now disagrees: the same honest-stale contract item 3 established for the INSERT side.
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "behind" });
    c.close();
  });

  /**
   * THE THIRD COMPATIBILITY TRIGGER, THE STATUS SIDE (Codex round 9, item 2, P2). Round 5's INSERT
   * trigger and round 8's UPDATE-of-circle trigger say nothing about an old build RETIRING or
   * RESTORING a concept — retireConcept/restoreConcept's own pre-mirror-widening code UPDATEs
   * `concepts.status` directly, so an old build retiring an ADVISORY rule (its own era only tracked
   * blocking, if it bumped status at all) leaves the new build's on-disk mirror serving the retired
   * rule as current, indefinitely — nothing else ever re-triggers a refresh for a concept nobody
   * touches again.
   */
  it("an old-build-shaped status UPDATE retiring a bound ADVISORY rule bumps gate_meta's generation too, and isSidecarStale reports the on-disk mirror stale (Codex round 9, item 2)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    const seed = await c.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Confirm the lockfile before installing.", severity: "advisory", scope: "domain",
    });
    if (seed.species !== "rule") throw new Error("unreachable");
    c.materializeGateMirror(path);
    expect(c.isSidecarStale().stale).toBe(false);
    expect((JSON.parse(readFileSync(path, "utf8")) as GateMirror).entries).toHaveLength(1); // live pre-retire
    const generationBefore = c.sidecarGeneration();

    // THE OLD BUILD'S OWN UPDATE — concepts.status alone, exactly what retireConcept's pre-mirror-
    // widening code issues; no gate_meta statement anywhere near it, and (its own era) no bump at
    // all for an ADVISORY rule specifically, only ever for blocking.
    raw(c).prepare(`UPDATE concepts SET status = 'retired' WHERE id = ?`).run(seed.conceptId);

    expect(c.sidecarGeneration()).toBeGreaterThan(generationBefore);
    // THE FILE ITSELF NEVER MOVED — still reports the retired rule as live — so the comparison now
    // disagrees: the same honest-stale contract items 3 and round-8-item-2 established.
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "behind" });
    c.close();
  });

  it("does NOT bump for an ordinary fact's status churn — the EXISTS-on-rule_bindings scope holds, not a blanket status trigger (Codex round 9, item 2)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const fact = await c.store("A fact with no rule binding at all.", { kind: "fact" });
    const before = c.sidecarGeneration();
    c.retireConcept(fact.conceptId);
    expect(c.sidecarGeneration()).toBe(before); // no rule_bindings row for this concept — no-op
    c.restoreConcept(fact.conceptId);
    expect(c.sidecarGeneration()).toBe(before);
    c.close();
  });

  /**
   * NEW-BUILD retireConcept/restoreConcept STILL BUMP EXACTLY ONCE (Codex round 9, item 2's own
   * double-bump check — the round-8 lesson applied before shipping: an increment is not idempotent).
   * `noteRuleTouched(id)` was REMOVED from both call sites (engine.ts) because
   * trg_rule_bindings_follow_concept_status's own WHEN clause is `hasLiveBinding`'s EXACT predicate,
   * not merely a superset — the broader "bumps exactly once per mutation class" test already covers
   * retireConcept incidentally (step 5); this pins BOTH directions explicitly and by name.
   */
  it("retireConcept and restoreConcept each bump gate_meta exactly once for a bound rule, not twice (Codex round 9, item 2, exact-count)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const deny = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", reason: "there is no undo", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    await withdrawDeny(c, deny.conceptId, "rm -rf");
    const beforeRetire = c.sidecarGeneration();
    c.retireConcept(deny.conceptId);
    expect(c.sidecarGeneration()).toBe(beforeRetire + 1);

    const beforeRestore = c.sidecarGeneration();
    c.restoreConcept(deny.conceptId);
    expect(c.sidecarGeneration()).toBe(beforeRestore + 1);
    c.close();
  });

  /**
   * CLOSING THE FAMILY, THE STAGE SIDE (Codex round 10, items 2+3, P2 — one of the two findings
   * named by the coordinator). An old build's own upsertStage gated its bump on
   * `liveBlockingRulesForStage(...).length > 0` — correct while the mirror was blocking-only,
   * silently wrong once GateMirror.stages started carrying every stage, rule-bound or not. See
   * `trg_stages_bump_on_trigger_patterns`'s own comment (gates.ts) for the full argument.
   */
  it("an old-build-shaped UPDATE of a stage's trigger_patterns bumps gate_meta's generation too, and isSidecarStale reports the on-disk mirror stale (Codex round 10, items 2+3)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    await c.declare({ species: "stage", stage: "npm install", patterns: ["Bash:npm install"] });
    const stageId = c.stages()[0]!.id;
    c.materializeGateMirror(path);
    expect(c.isSidecarStale().stale).toBe(false);
    const generationBefore = c.sidecarGeneration();

    // THE OLD BUILD'S OWN UPDATE — trigger_patterns alone, exactly what an old, blocking-only-era
    // upsertStage issues for a stage with no live blocking rule bound (its own gate: `if
    // (liveBlockingRulesForStage(db, existing.id).length > 0) bumpGateGeneration(db)`, absent here).
    raw(c).prepare(`UPDATE stages SET trigger_patterns = ? WHERE id = ?`).run(
      JSON.stringify([{ tool: "bash", tokens: ["npm", "ci"] }]), stageId,
    );

    expect(c.sidecarGeneration()).toBeGreaterThan(generationBefore);
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "behind" });
    c.close();
  });

  it("does NOT bump for a same-value UPDATE of trigger_patterns — the OLD-IS-NOT-NEW guard holds, matching the sibling triggers (Codex round 10, items 2+3)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    await c.declare({ species: "stage", stage: "npm install", patterns: ["Bash:npm install"] });
    const stageId = c.stages()[0]!.id;
    const currentPatterns = raw(c).prepare(`SELECT trigger_patterns FROM stages WHERE id = ?`).get(stageId) as { trigger_patterns: string };
    const before = c.sidecarGeneration();
    raw(c).prepare(`UPDATE stages SET trigger_patterns = ? WHERE id = ?`).run(currentPatterns.trigger_patterns, stageId);
    expect(c.sidecarGeneration()).toBe(before);
    c.close();
  });

  /**
   * NEW-BUILD stage re-authoring bumps EXACTLY ONCE, not twice (Codex round 10, items 2+3,
   * exact-count) — upsertStage's own explicit bump was REMOVED (unlike bindRule's, kept — see
   * that trigger's own comment for why the two cases differ), because upsertStage's own
   * pre-existing no-op guard (`nextPatterns === existing.trigger_patterns → return existing`)
   * already made its removed bump an EXACT match for `trg_stages_bump_on_trigger_patterns`'s own
   * condition, not merely a superset.
   */
  it("declare({species:'stage'}) re-authoring patterns bumps gate_meta exactly once, not twice (Codex round 10, items 2+3, exact-count)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    await c.declare({ species: "stage", stage: "npm install", patterns: ["Bash:npm install"] });
    const before = c.sidecarGeneration();
    await c.declare({ species: "stage", stage: "npm install", patterns: ["Bash:npm install", "Bash:npm ci"] });
    expect(c.sidecarGeneration()).toBe(before + 1);
    c.close();
  });

  /**
   * CLOSING THE FAMILY, THE TITLE SIDE (Codex round 10, items 2+3, P2 — the other finding named by
   * the coordinator). An old build's own retitling code (synthesizeRow and its three swept twins,
   * engine.ts) predates knowing an ADVISORY rule's retitle is mirror-relevant at all — the mirror
   * was blocking-only when those paths were first written. See
   * `trg_rule_bindings_follow_concept_title`'s own comment (gates.ts) for the full argument.
   */
  it("an old-build-shaped UPDATE of a bound ADVISORY rule's title (a retitle) bumps gate_meta's generation too, and isSidecarStale reports the on-disk mirror stale (Codex round 10, items 2+3)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    const seed = await c.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Confirm the lockfile before installing.", severity: "advisory", scope: "domain",
    });
    if (seed.species !== "rule") throw new Error("unreachable");
    c.materializeGateMirror(path);
    expect(c.isSidecarStale().stale).toBe(false);
    expect((JSON.parse(readFileSync(path, "utf8")) as GateMirror).entries[0]!.text).toBe("Confirm the lockfile before installing");
    const generationBefore = c.sidecarGeneration();

    // THE OLD BUILD'S OWN UPDATE — title alone, exactly what old, blocking-only-era synthesis code
    // (synthesizeRow, applySynthesis, resolveContradiction, detach()'s partial-detach — all
    // predating the mirror widening) issues for an advisory rule's concept.
    raw(c).prepare(`UPDATE concepts SET title = ? WHERE id = ?`).run("Confirm the lockfile is present before installing", seed.conceptId);

    expect(c.sidecarGeneration()).toBeGreaterThan(generationBefore);
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "behind" });
    c.close();
  });

  it("does NOT bump for a same-value UPDATE of a concept's title — the OLD-IS-NOT-NEW guard holds (Codex round 10, items 2+3)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const seed = await c.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Confirm the lockfile before installing.", severity: "advisory", scope: "domain",
    });
    if (seed.species !== "rule") throw new Error("unreachable");
    const before = c.sidecarGeneration();
    raw(c).prepare(`UPDATE concepts SET title = ? WHERE id = ?`).run("Confirm the lockfile before installing", seed.conceptId);
    expect(c.sidecarGeneration()).toBe(before);
    c.close();
  });

  it("does NOT bump for an ordinary fact's retitle — the EXISTS-on-rule_bindings scope holds, not a blanket title trigger (Codex round 10, items 2+3)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const fact = await c.store("A fact with no rule binding at all.", { kind: "fact" });
    const before = c.sidecarGeneration();
    raw(c).prepare(`UPDATE concepts SET title = ? WHERE id = ?`).run("A retitled fact.", fact.conceptId);
    expect(c.sidecarGeneration()).toBe(before);
    c.close();
  });

  /**
   * NEW-BUILD retitling bumps EXACTLY ONCE, not twice (Codex round 10, items 2+3, exact-count) —
   * all four `noteRuleTouched` calls tied to a title-only write were REMOVED (resolveContradiction,
   * applySynthesis, detach()'s partial-detach, synthesizeRow — engine.ts, each site's own comment),
   * because `hasLiveBinding` (what each called) is the EXACT condition
   * `trg_rule_bindings_follow_concept_title`'s own WHEN clause tests, not merely a superset.
   */
  it("applySynthesis retitling a bound rule bumps gate_meta exactly once, not twice (Codex round 10, items 2+3, exact-count)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const seed = await c.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Confirm the lockfile before installing.", severity: "advisory", scope: "domain",
    });
    if (seed.species !== "rule") throw new Error("unreachable");
    raw(c).prepare(`UPDATE concepts SET dirty = 1 WHERE id = ?`).run(seed.conceptId); // force synthesis to actually run
    const before = c.sidecarGeneration();
    await c.applySynthesis(seed.conceptId, "Always confirm the lockfile is present and committed before installing.");
    expect(c.sidecarGeneration()).toBe(before + 1);
    c.close();
  });

  /**
   * CLOSING THE FAMILY, THE THIRD GAP THE AUDIT ITSELF FOUND (Codex round 10, items 2+3 — beyond
   * the two the coordinator named by name): stage_id/severity/scope/model_tag/origin/declared_by/
   * reason all move together through bindRule's own "replace" branch (gates.ts), whose bump was
   * ALSO historically gated on touching deny power. See
   * `trg_rule_bindings_bump_on_reclassification`'s own comment (gates.ts) for the full argument,
   * including why — unlike every other trigger in this family — bindRule's own JS-side bump is
   * KEPT rather than removed, and the accepted double-bump that follows for a genuine new-build
   * reclassification.
   */
  it("an old-build-shaped UPDATE of a bound ADVISORY rule's scope/model_tag/reason (staying advisory throughout) bumps gate_meta's generation too, and isSidecarStale reports the on-disk mirror stale (Codex round 10, items 2+3)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    const seed = await c.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Confirm the lockfile before installing.", severity: "advisory", scope: "agent", modelTag: "old-model",
    });
    if (seed.species !== "rule") throw new Error("unreachable");
    c.materializeGateMirror(path);
    expect(c.isSidecarStale().stale).toBe(false);
    const generationBefore = c.sidecarGeneration();

    // THE OLD BUILD'S OWN UPDATE — scope/model_tag/reason, severity UNCHANGED (advisory throughout,
    // so deny power is never in play) — exactly what an old, blocking-only-era bindRule's own
    // "replace" branch issues, with its own bump gated on `touchesDenyPower` and so absent here.
    raw(c).prepare(`UPDATE rule_bindings SET scope = 'domain', model_tag = NULL, reason = 'updated reason' WHERE concept_id = ?`)
      .run(seed.conceptId);

    expect(c.sidecarGeneration()).toBeGreaterThan(generationBefore);
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "behind" });
    c.close();
  });

  it("does NOT bump for a same-value UPDATE of rule_bindings' scope/model_tag/origin/declared_by/reason/stage_id — the OLD-IS-NOT-NEW guard holds across all seven (Codex round 10, items 2+3)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const seed = await c.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Confirm the lockfile before installing.", severity: "advisory", scope: "agent", modelTag: "some-model",
    });
    if (seed.species !== "rule") throw new Error("unreachable");
    const current = raw(c).prepare(`SELECT stage_id, scope, model_tag, origin, declared_by, reason FROM rule_bindings WHERE concept_id = ?`)
      .get(seed.conceptId) as { stage_id: string; scope: string; model_tag: string; origin: string; declared_by: string | null; reason: string };
    const before = c.sidecarGeneration();
    raw(c).prepare(
      `UPDATE rule_bindings SET stage_id = ?, scope = ?, model_tag = ?, origin = ?, declared_by = ?, reason = ? WHERE concept_id = ?`,
    ).run(current.stage_id, current.scope, current.model_tag, current.origin, current.declared_by, current.reason, seed.conceptId);
    expect(c.sidecarGeneration()).toBe(before);
    c.close();
  });

  /**
   * THE ACCEPTED DOUBLE-BUMP, NAMED AND VERIFIED, NOT LEFT UNDOCUMENTED (Codex round 10, items 2+3):
   * a genuine new-build reclassification (declare() re-aiming an already-advisory rule's scope,
   * staying advisory throughout) bumps TWICE — once from bindRule's own kept, unconditional bump,
   * once from `trg_rule_bindings_bump_on_reclassification`. Deliberately not "exactly once", unlike
   * every sibling exact-count test above — see that trigger's own comment (gates.ts) for why
   * bindRule's own call could not be safely removed the way every other one in this family was.
   */
  it("declare() re-aiming an already-advisory rule's scope bumps gate_meta TWICE — an accepted, documented double-bump, not an exact-count regression (Codex round 10, items 2+3)", async () => {
    // DEFAULT (ENABLED) DEDUP, not this describe block's own disabled-dedup convention — deliberately:
    // the second declare() call below must resolve to the SAME concept as the first (identical
    // content), which enabled dedup guarantees and disabled dedup does not — the exact same
    // consideration DOOR 13.11's own comment already verified against the working "PATH 1 — breadth"
    // precedent test.
    const c = new MonetCore(":memory:", {});
    const seed = await c.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Confirm the lockfile before installing.", severity: "advisory", scope: "agent", modelTag: "some-model",
    });
    if (seed.species !== "rule") throw new Error("unreachable");
    const before = c.sidecarGeneration();
    const reclassified = await c.declare({
      species: "rule", stage: "npm install", content: "Confirm the lockfile before installing.",
      severity: "advisory", scope: "domain",
    });
    if (reclassified.species !== "rule") throw new Error("unreachable");
    expect(reclassified.conceptId).toBe(seed.conceptId);
    expect(c.sidecarGeneration()).toBe(before + 2);
    c.close();
  });

  /**
   * CLOSING THE VERB DIMENSION (Codex round 11): round 10's own family table enumerated COLUMNS an
   * old build's UPDATE could touch, but never asked what an old build's INSERT or DELETE against the
   * SAME tables could miss. The next several tests close stages' own INSERT (item 1), concepts' own
   * hard DELETE (item 2), and circle_aliases' full INSERT/UPDATE/DELETE (item 3) — the same
   * old-build-shaped-raw-statement technique every trigger above already uses.
   */
  it("an old-build-shaped stage INSERT bumps gate_meta's generation too, and isSidecarStale reports the on-disk mirror stale (Codex round 11, item 1)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    // A fresh materialize so the ON-DISK file's own stamped generation is CURRENT before the probe —
    // isolates this test to what the trigger itself does, matching this family's own established
    // pattern (round 7, item 3's INSERT-bump test, above).
    c.materializeGateMirror(path);
    expect(c.isSidecarStale().stale).toBe(false);
    const generationBefore = c.sidecarGeneration();

    // THE OLD BUILD'S OWN INSERT — a brand-new, RULE-LESS stage, exactly the shape upsertStage's own
    // NEW-STAGE branch writes; no rule ever binds to it in this test, because the finding is about
    // the STAGE'S OWN ARRIVAL being mirror content (GateMirror.stages carries the full registry,
    // rule-less stages included — see listGateMirrorStages' own comment), not about anything
    // rule-shaped.
    raw(c).prepare(
      `INSERT INTO stages (id, name, trigger_patterns, origin, verified, created_at, sync_updated_at, sync_revision, sync_writer)
       VALUES ('old-build-stage', 'a rule-less stage', '[]', 'declaration', 0, ?, ?, 0, 'old-build')`,
    ).run(Date.now(), Date.now());

    // IMMEDIATELY — no reopen, no restart. The trigger fired synchronously inside the INSERT above.
    expect(c.sidecarGeneration()).toBeGreaterThan(generationBefore);
    expect(c.isSidecarStale().stale).toBe(true);
    c.close();
  });

  it("declare({species:'stage'}) creating a BRAND NEW stage bumps gate_meta's generation exactly once — the trigger alone, now that upsertStage's own JS-side bump has been removed (Codex round 11, item 1, exact-count)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const before = c.sidecarGeneration();
    const registered = await c.declare({
      species: "stage", stage: "a brand new rule-less stage", patterns: ["Bash:some new command"],
    });
    expect(registered.species).toBe("stage");
    // Exactly once, not twice: upsertStage's own explicit bumpGateGeneration(db) call on this branch
    // is GONE (removed — Codex round 11, item 1), an exact-match resolution against
    // trg_stages_bump_on_insert, which now does this alone — a regression back to a JS-side call
    // sitting alongside the trigger would show as +2 here, not +1.
    expect(c.sidecarGeneration()).toBe(before + 1);
    c.close();
  });

  /**
   * THE DELETE SIDE, CONCEPTS (Codex round 11, item 2, P2). A hard-deleted concept's own rule
   * binding disappears from listGateMirrorEntries' own result set (the INNER JOIN to concepts simply
   * stops matching it) exactly like a retire, but via DELETE rather than UPDATE. An old build's own
   * hard-delete code — its era: blocking-only bump gates — bumped nothing for an ADVISORY-bound
   * concept's own hard delete.
   */
  it("an old-build-shaped hard DELETE of a concept carrying a live ADVISORY binding bumps gate_meta's generation too, and isSidecarStale reports the on-disk mirror stale (Codex round 11, item 2)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    const advisoryRule = await c.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Confirm the lockfile before installing.", severity: "advisory", scope: "domain",
    });
    if (advisoryRule.species !== "rule") throw new Error("unreachable");
    c.materializeGateMirror(path);
    expect(c.isSidecarStale().stale).toBe(false);
    const generationBefore = c.sidecarGeneration();

    // THE OLD BUILD'S OWN HARD DELETE — its era's equivalent of hardDeleteNativeConcept, minus the
    // noteRuleTouched call this fix removes and minus every OTHER bookkeeping statement this item
    // does not concern (concept_deletions, first_block, etc.): isolates this test to the ONE
    // statement whose trigger this item is about — the concepts row itself disappearing. The
    // binding row is deliberately left behind, ORPHANED — verified by absence elsewhere in this
    // codebase that rule_bindings is never explicitly deleted anywhere, so this is the REAL shape a
    // hard delete leaves, old build or new.
    raw(c).prepare(`DELETE FROM concepts WHERE id = ?`).run(advisoryRule.conceptId);

    expect(c.sidecarGeneration()).toBeGreaterThan(generationBefore);
    expect(c.isSidecarStale().stale).toBe(true);
    c.close();
  });

  it("does NOT bump for hard-deleting an ordinary FACT concept with no rule binding at all — the EXISTS-on-rule_bindings scope holds, not a blanket delete trigger (Codex round 11, item 2)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const fact = await c.store("An ordinary fact, never a rule.", { kind: "fact" });
    const before = c.sidecarGeneration();
    raw(c).prepare(`DELETE FROM concepts WHERE id = ?`).run(fact.conceptId);
    expect(c.sidecarGeneration()).toBe(before);
    c.close();
  });

  it("a NEW-build hard delete of an advisory-bound concept (consolidating detach) bumps gate_meta's generation exactly once — the trigger alone, now that hardDeleteNativeConcept's own noteRuleTouched call has been removed (Codex round 11, item 2, exact-count)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const advisoryRule = await c.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Confirm the lockfile before installing.", severity: "advisory", scope: "domain",
    });
    if (advisoryRule.species !== "rule") throw new Error("unreachable");
    const other = await c.store("An unrelated concept to consolidate onto.", { kind: "fact" });
    const full = await c.getConcept(advisoryRule.conceptId);

    const before = c.sidecarGeneration();
    // Consolidating detach: ALL of the rule's observations move to `other`, so the emptied rule
    // concept is hard-deleted — advisory, so assertBlockingRuleMutationAllowed lets it through.
    await c.detach(advisoryRule.conceptId, full!.observations.map((o) => o.id), { destConceptId: other.conceptId });
    // Exactly once, not twice: a regression re-adding hardDeleteNativeConcept's own JS-side bump
    // alongside trg_concepts_bump_on_delete would show as +2 here, not +1.
    expect(c.sidecarGeneration()).toBe(before + 1);
    c.close();
  });

  /**
   * THE CIRCLE_ALIASES VERBS (Codex round 11, item 3, P2). Unlike every trigger above, this gap is
   * not "blocking-only vs widened" — circle_aliases/circles were ADDED to the mirror in format 4
   * ITSELF, so ANY build predating that slice has no bump of any kind for an alias write, regardless
   * of severity. All three verbs, tested directly against the raw table, matching this family's own
   * established old-build-shaped-statement technique.
   */
  it("an old-build-shaped raw INSERT into circle_aliases bumps gate_meta's generation, and isSidecarStale reports the on-disk mirror stale (Codex round 11, item 3)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    c.materializeGateMirror(path);
    expect(c.isSidecarStale().stale).toBe(false);
    const generationBefore = c.sidecarGeneration();

    raw(c).prepare(`INSERT INTO circle_aliases (from_name, to_name, status) VALUES ('old-from', 'old-to', 'active')`).run();

    expect(c.sidecarGeneration()).toBeGreaterThan(generationBefore);
    expect(c.isSidecarStale().stale).toBe(true);
    c.close();
  });

  it("an old-build-shaped raw UPDATE of circle_aliases bumps gate_meta's generation, and isSidecarStale reports the on-disk mirror stale (Codex round 11, item 3)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    raw(c).prepare(`INSERT INTO circle_aliases (from_name, to_name, status) VALUES ('old-from', 'old-to', 'active')`).run();
    c.materializeGateMirror(path);
    expect(c.isSidecarStale().stale).toBe(false);
    const generationBefore = c.sidecarGeneration();

    raw(c).prepare(`UPDATE circle_aliases SET status = 'archived' WHERE from_name = 'old-from'`).run();

    expect(c.sidecarGeneration()).toBeGreaterThan(generationBefore);
    expect(c.isSidecarStale().stale).toBe(true);
    c.close();
  });

  it("an old-build-shaped raw DELETE from circle_aliases bumps gate_meta's generation, and isSidecarStale reports the on-disk mirror stale (Codex round 11, item 3)", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    raw(c).prepare(`INSERT INTO circle_aliases (from_name, to_name, status) VALUES ('old-from', 'old-to', 'active')`).run();
    c.materializeGateMirror(path);
    expect(c.isSidecarStale().stale).toBe(false);
    const generationBefore = c.sidecarGeneration();

    // No application code path ever issues this DELETE today (renameCircle/mergeCircle/
    // archiveCircle/unarchiveCircle all upsert, never delete) — tested anyway, both because the
    // trigger exists unconditionally and because a raw DELETE is exactly the class of statement this
    // whole mixed-build family defends against, reachable or not through today's own app code.
    raw(c).prepare(`DELETE FROM circle_aliases WHERE from_name = 'old-from'`).run();

    expect(c.sidecarGeneration()).toBeGreaterThan(generationBefore);
    expect(c.isSidecarStale().stale).toBe(true);
    c.close();
  });

  it("mergeCircle of an EMPTY circle (zero concepts in `from`) bumps gate_meta's generation exactly once — the circle_aliases trigger alone, now that mergeCircle's own JS-side bump has been removed (Codex round 11, item 3, exact-count)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const before = c.sidecarGeneration();
    // "empty-source" holds nothing at all — no concept, no prior alias — which mergeCircle allows
    // (no existence check on `from`, unlike renameCircle's own). The for-loop over conceptRows is a
    // clean no-op, isolating this test to the alias write alone.
    await c.mergeCircle("empty-source", "keep");
    expect(c.sidecarGeneration()).toBe(before + 1);
    c.close();
  });

  it("archiveCircle of a brand-new (never-before-seen) circle name bumps gate_meta's generation exactly once — the circle_aliases trigger alone, now that archiveCircle's own JS-side bump has been removed (Codex round 11, item 3, exact-count)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const before = c.sidecarGeneration();
    // archiveCircle has no existence requirement at all (unlike renameCircle's own) — archiving a
    // name with no prior alias row just upserts one, fresh.
    c.archiveCircle("never-seen-before");
    expect(c.sidecarGeneration()).toBe(before + 1);
    c.close();
  });

  it("unarchiveCircle bumps gate_meta's generation exactly once when it actually flips a row back to active, and NOT AT ALL for its documented no-op (no alias row exists) — the trigger's own per-row firing is an exact match for the removed `changes > 0` gate (Codex round 11, item 3, exact-count)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    c.archiveCircle("shelved");
    const before = c.sidecarGeneration();
    c.unarchiveCircle("shelved");
    expect(c.sidecarGeneration()).toBe(before + 1);

    // THE DOCUMENTED NO-OP: no alias row exists for this name at all — the UPDATE's WHERE clause
    // matches zero rows, so trg_circle_aliases_bump_on_update fires zero times too, exactly as the
    // removed `if (r.changes > 0)` JS gate used to test.
    const beforeNoop = c.sidecarGeneration();
    c.unarchiveCircle("a-name-that-was-never-archived");
    expect(c.sidecarGeneration()).toBe(beforeNoop);
    c.close();
  });

  /**
   * NEVER MINT BREADTH FROM A COMPATIBILITY MOVE (Codex round 12, P1 — found by review). Two
   * triggers in this family copy a circle value verbatim from somewhere else; both had the same
   * hole, both are fixed the same way, both get their own test here.
   */
  it("an old-build-shaped UPDATE of a concept's circle INTO the reserved '*' marker does NOT mint breadth on its binding — refused rather than treated as an ordinary move (Codex round 12, P1)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const localRule = await c.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Confirm the lockfile before installing.", severity: "blocking", scope: "domain",
      reason: "an unlocked install can drift", circle: "project",
    });
    if (localRule.species !== "rule") throw new Error("unreachable");
    const before = c.sidecarGeneration();

    // THE OLD BUILD'S OWN UPDATE — moving the concept into a circle literally spelled "*", legal
    // under its own pre-breadth freedom (arbitrary circle names), with zero awareness the marker is
    // now reserved. Before this fix: the sibling trigger copied it straight into rule_bindings.circle
    // — a BLOCKING rule silently made global, on the strength of an old process's ordinary move.
    raw(c).prepare(`UPDATE concepts SET circle = ? WHERE id = ?`).run(BREADTH_CIRCLE, localRule.conceptId);

    // THE BINDING STAYS PUT — no mint, no crash.
    const afterMove = raw(c).prepare(`SELECT circle FROM rule_bindings WHERE concept_id = ?`).get(localRule.conceptId) as { circle: string };
    expect(afterMove.circle).toBe("project");
    // The CONCEPT itself did move (this trigger never touches `concepts`) — legacy-star cleanup is
    // a separate, later concern (the next new-build open), unaffected by this fix either way.
    expect(raw(c).prepare(`SELECT circle FROM concepts WHERE id = ?`).get(localRule.conceptId)).toEqual({ circle: BREADTH_CIRCLE });
    // NO BUMP either — nothing mirror-relevant changed (the binding, which is what the mirror reads
    // for this rule, never moved).
    expect(c.sidecarGeneration()).toBe(before);
    // And the deny still fires from exactly where it always did.
    expect(c.gate({ actionContext: "Bash:npm install", circle: "project" }).rules.map((r) => r.conceptId))
      .toContain(localRule.conceptId);
    c.close();
  });

  it("an old-build-shaped raw INSERT into rule_bindings, whose concept already lives in the reserved '*' circle, resolves to NULL rather than minting breadth (Codex round 12, P1 — same audit, the backfill trigger)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const seed = await c.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Seed rule so a real stage exists to bind against.", severity: "advisory", scope: "domain",
    });
    if (seed.species !== "rule") throw new Error("unreachable");
    const stageId = c.ruleBinding(seed.conceptId)!.stage_id;

    // A concept ALREADY sitting in the reserved circle (the legacy pre-breadth shape) — no binding
    // yet.
    const pathological = await c.store("A concept an old build already parked in '*'.", { kind: "fact" });
    raw(c).prepare(`UPDATE concepts SET circle = ? WHERE id = ?`).run(BREADTH_CIRCLE, pathological.conceptId);

    // THE OLD BUILD'S OWN INSERT — the pre-breadth column shape, binding this pathological concept.
    raw(c).prepare(
      `INSERT INTO rule_bindings
         (concept_id, stage_id, severity, scope, model_tag, origin, declared_by, reason,
          created_at, sync_updated_at, sync_revision, sync_writer)
       VALUES (?, ?, 'advisory', 'domain', NULL, 'declaration', NULL, 'an old-build reason', ?, ?, 0, 'old-build')`,
    ).run(pathological.conceptId, stageId, Date.now(), Date.now());

    // NULL, not '*' — resolves the SAME way a genuinely dangling binding (no concept at all) already
    // does, not minted.
    const landed = raw(c).prepare(`SELECT circle FROM rule_bindings WHERE concept_id = ?`).get(pathological.conceptId) as { circle: string | null };
    expect(landed.circle).toBeNull();
    expect(c.gate({ actionContext: "Bash:npm install", circle: "a-circle-nothing-else-touches" }).rules.map((r) => r.conceptId))
      .not.toContain(pathological.conceptId);
    c.close();
  });

  it("the bulk backfill does NOT bump when the only NULL-circle bindings are unresolvable — dangling (no concept at all) or parked in the reserved '*' circle — miscounting either as resolved was the exact review finding (Codex round 12, P2)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const seed = await c.declare({
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"],
      content: "Seed rule so a real stage exists to bind against.", severity: "advisory", scope: "domain",
    });
    if (seed.species !== "rule") throw new Error("unreachable");
    const stageId = c.ruleBinding(seed.conceptId)!.stage_id;
    const db = raw(c) as unknown as StoragePort;

    // DANGLING: concept_id names no row in concepts at all.
    db.prepare(
      `INSERT INTO rule_bindings
         (concept_id, stage_id, severity, scope, model_tag, origin, declared_by, reason,
          created_at, sync_updated_at, sync_revision, sync_writer)
       VALUES ('dangling-nowhere', ?, 'advisory', 'domain', NULL, 'declaration', NULL, NULL, ?, ?, 0, 'old-build')`,
    ).run(stageId, Date.now(), Date.now());

    // PARKED IN '*': the concept exists, but sits in the reserved circle — the fixed INSERT trigger
    // (its own test, above) already leaves such a binding's circle NULL rather than minting; this
    // test is about the BULK backfill agreeing that it is NOT a resolution to count, not re-testing
    // the trigger itself.
    const parked = await c.store("A concept an old build already parked in '*'.", { kind: "fact" });
    raw(c).prepare(`UPDATE concepts SET circle = ? WHERE id = ?`).run(BREADTH_CIRCLE, parked.conceptId);
    db.prepare(
      `INSERT INTO rule_bindings
         (concept_id, stage_id, severity, scope, model_tag, origin, declared_by, reason,
          created_at, sync_updated_at, sync_revision, sync_writer)
       VALUES (?, ?, 'advisory', 'domain', NULL, 'declaration', NULL, NULL, ?, ?, 0, 'old-build')`,
    ).run(parked.conceptId, stageId, Date.now(), Date.now());

    const generationBefore = (db.prepare(`SELECT generation FROM gate_meta WHERE singleton = 1`).get() as { generation: number }).generation;

    // Calling migrateGateColumns AGAIN, directly — the SAME idempotent re-entry this module's own
    // "concurrent-migrator race"/"survives a second migration pass" tests already rely on, isolating
    // this test to the bulk backfill's OWN behavior rather than construction's own two-call sequence
    // (round 11, item 3).
    migrateGateColumns(db);

    // NO BUMP — neither row was actually resolvable (EXISTS fails for both, for different reasons),
    // so neither is touched by the UPDATE's own WHERE clause, so neither is miscounted as resolved.
    expect((db.prepare(`SELECT generation FROM gate_meta WHERE singleton = 1`).get() as { generation: number }).generation)
      .toBe(generationBefore);
    expect((db.prepare(`SELECT circle FROM rule_bindings WHERE concept_id = 'dangling-nowhere'`).get() as { circle: string | null }).circle)
      .toBeNull();
    expect((db.prepare(`SELECT circle FROM rule_bindings WHERE concept_id = ?`).get(parked.conceptId) as { circle: string | null }).circle)
      .toBeNull();
    c.close();
  });

  it("the trigger survives a second migration pass — idempotent CREATE TRIGGER IF NOT EXISTS, not merely accidentally harmless (Codex round 5, item 4)", () => {
    const dir = mkTmp();
    const path = join(dir, "trigger-idempotent.db");
    const port = new BetterSqlitePort(path);
    // A MINIMAL concepts table — just enough for the backfill's own "GUARDED ON concepts EXISTING"
    // check to see it (the pure schema-race fixture above deliberately has none at all; this test is
    // about a DIFFERENT concern, the trigger's own idempotent creation, which needs the guard to pass
    // so the trigger actually gets created in the first place).
    port.exec(`CREATE TABLE concepts (id TEXT PRIMARY KEY, circle TEXT NOT NULL DEFAULT 'default')`);
    createGateSchema(port); // first pass: creates rule_bindings, adds circle, creates the trigger
    createGateSchema(port); // second pass: must not throw, must not duplicate the trigger

    const triggers = port.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_rule_bindings_backfill_circle'`,
    ).all() as Array<{ name: string }>;
    expect(triggers).toHaveLength(1);

    // AND IT STILL WORKS after the second pass — not merely present, but functioning. No `stages`
    // FK is enforced at the SQL layer (this table has none), so a dummy stage_id is enough to prove
    // the INSERT itself does not throw — that the trigger body is valid SQL against this schema —
    // without needing a real stage row. `concept_id` names nothing in the minimal `concepts` table
    // above, exercising the SAME no-op path the dangling case does: circle stays NULL, silently.
    expect(() =>
      port.prepare(
        `INSERT INTO rule_bindings
           (concept_id, stage_id, severity, scope, model_tag, origin, declared_by, reason,
            created_at, sync_updated_at, sync_revision, sync_writer)
         VALUES ('trigger-survives-check', 'dummy-stage', 'advisory', 'domain', NULL, 'declaration', NULL, NULL, 1, 1, 0, 'x')`,
      ).run(),
    ).not.toThrow();
    const stillDangling = port.prepare(`SELECT circle FROM rule_bindings WHERE concept_id = 'trigger-survives-check'`)
      .get() as { circle: string | null };
    expect(stillDangling.circle).toBeNull();
    port.close();
  });

  /**
   * ONE TRANSACTION FOR THE WHOLE MIGRATION (Codex round 7, item 1, P1). Before this fix, each write
   * inside migrateLegacyStarCircle auto-committed on its own — concepts, then observations, then
   * edges, then normative rows, then the source registry, then aliases, then the generation bump —
   * so a crash between any two of them left a HALF-MOVED store: exactly the "concepts moved,
   * sources/aliases not, or worse" shape this item names. Injected via a probe StoragePort (matching
   * this describe block's own StaleMatcherProbeStorage precedent), throwing partway through
   * moveCircleScopedTables itself — after concepts/observations/edges/normative rows have already
   * been touched, before knowledge_sources, entities, first_block, alias cleanup, or the generation
   * bump ever run — the worst-shaped partial failure available, not merely a clean early one.
   */
  it("a migration that throws mid-way (moveCircleScopedTables itself, after concepts have already moved) leaves the store byte-identical to pre-migration; the successful path is unchanged (Codex round 7, item 1)", async () => {
    const dir = mkTmp();
    const path = join(dir, "migration-atomicity.db");
    const built = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
    const legacyFact = await built.store("A fact from before gates existed.", {
      circle: "an-ordinary-circle", kind: "fact",
    });
    built.close();

    const legacy = new Database(path);
    legacy.prepare(`UPDATE concepts SET circle = '*' WHERE id = ?`).run(legacyFact.conceptId);
    legacy.close();

    // THE PRE-MIGRATION SNAPSHOT, byte for byte — not just "the concept's circle", the WHOLE file,
    // so nothing this migration could possibly touch (aliases, sources, the generation counter,
    // anything) can quietly slip through un-asserted.
    const preMigrationBytes = readFileSync(path);

    class ThrowingMidMigrationProbe extends BetterSqlitePort {
      override prepare(sql: string): Statement {
        // knowledge_sources.circle's own UPDATE (moveCircleScopedTables, engine.ts) — reached only
        // after concepts/observations/moveEdgeScope/lifecycle_edges/ratifications have already run
        // in this SAME call, and before entities/concept_entities/workstream slugs/first_block/the
        // alias cleanup/the generation bump ever get a chance to.
        if (/UPDATE knowledge_sources SET circle/.test(sql)) {
          throw new Error("INJECTED CRASH — simulated failure partway through the legacy-star migration");
        }
        return super.prepare(sql);
      }
    }

    // THE FIRST ATTEMPT, WITH THE FAULT INJECTED. Pre-fix, moveCircleScopedTables' own earlier
    // statements (concepts, observations, edges, normative rows) would already have auto-committed
    // by the time this throws — a half-moved store, permanently, since the concept's circle now
    // fails BOTH `hasLegacyStar` (it moved) and the migration's own idempotent re-run guard.
    expect(() => new MonetCore(new ThrowingMidMigrationProbe(path), { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" }))
      .toThrow(/INJECTED CRASH/);

    // BYTE-IDENTICAL. The whole migration rolled back as one unit — not merely "the concept is still
    // in '*'" (which a partial rollback could also produce by coincidence), the entire file is
    // unchanged, proving no partial write of ANY kind survived.
    const postCrashBytes = readFileSync(path);
    expect(postCrashBytes.equals(preMigrationBytes)).toBe(true);

    // THE SUCCESSFUL PATH, UNCHANGED: reopening normally (no probe, no fault) migrates cleanly on
    // this, genuinely, the FIRST successful attempt.
    const upgraded = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, syncDeviceId: "machine-a" });
    const migratedRow = raw(upgraded).prepare(`SELECT circle FROM concepts WHERE id = ?`).get(legacyFact.conceptId) as { circle: string };
    expect(migratedRow.circle).toBe(LEGACY_STAR_CIRCLE);
    expect(upgraded.sidecarGeneration()).toBeGreaterThan(0);
    upgraded.close();
  });
});

// ---------------------------------------------------------------------------
// stageLookup (standalone) — transaction boundaries (Codex round 4, item 3)
// ---------------------------------------------------------------------------

/**
 * Logs every `transaction()`/`immediateTransaction()` CALL and RUN (the wrapped function's actual
 * invocation — when the real BEGIN/COMMIT happens, not when the wrapper is merely constructed), in
 * order, so a test can assert the SHAPE of the transaction boundaries around a call: not just that
 * "some transaction" existed somewhere (a per-statement `inTransaction()` snapshot cannot tell one
 * merged transaction apart from two sequential ones — every statement in EITHER scenario runs with
 * SOME transaction open), but that the read phase shares exactly one, the write phase shares a
 * SEPARATE one, and the write's begins only after the read's has fully closed.
 */
class TransactionLoggingStorage extends BetterSqlitePort {
  readonly events: string[] = [];

  override transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    this.events.push("transaction:call");
    const wrapped = super.transaction(fn);
    return ((...args: A): R => {
      this.events.push("transaction:run:start");
      const r = wrapped(...args);
      this.events.push("transaction:run:end");
      return r;
    }) as (...args: A) => R;
  }

  override immediateTransaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    this.events.push("immediateTransaction:call");
    const wrapped = super.immediateTransaction(fn);
    return ((...args: A): R => {
      this.events.push("immediateTransaction:run:start");
      const r = wrapped(...args);
      this.events.push("immediateTransaction:run:end");
      return r;
    }) as (...args: A) => R;
  }
}

describe("stageLookup (standalone) — transaction boundaries", () => {
  it("wraps the read phase in ONE db.transaction(...), and commitGateWrites in its OWN separate db.immediateTransaction(...) afterward — mirrors MonetCore.stageLookup()'s own split exactly (Codex round 4, item 3). STRUCTURAL ASSERTION chosen over true concurrency: a genuine concurrent-writer race would need a second real connection racing mid-read, which is disproportionate to set up deterministically; this instead proves the CODE SHAPE the race protection depends on.", async () => {
    const dir = mkTmp();
    const path = join(dir, "monet.db");
    const setup = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1 });
    // A CAPPED scenario forces evaluateStageLookup's richest read shape (findStage, rulesForStages,
    // countLiveRulesForStage, ruleOutlineForStage) — proving ALL of them, not just a single-
    // statement HIT, share the one read transaction.
    const RULE_COUNT = STAGE_LOOKUP_RULES_CAP + 1;
    for (let i = 0; i < RULE_COUNT; i++) {
      await setup.store(`Rule number ${i}.`, {
        kind: "rule", resolution: "forceNew", rule: { stage: "bulk stage", scope: "domain" },
      });
    }
    setup.close();

    const port = new TransactionLoggingStorage(path);
    const result = standaloneStageLookup(port, { stage: "bulk stage", circle: "default", nextSyncTimestamp: () => Date.now() });
    port.close();

    expect(result.matched).toBe(true);
    expect(result.rulesTotal).toBe(RULE_COUNT); // sanity: this really is the capped, multi-read path

    // EXACTLY ONE read transaction, EXACTLY ONE write transaction — the same shape
    // MonetCore.stageLookup() itself uses (engine.ts), not zero (unwrapped — the bug) and not one
    // shared transaction spanning both (which would defeat the write's own allowed-to-fail split).
    expect(port.events.filter((e) => e === "transaction:call")).toHaveLength(1);
    expect(port.events.filter((e) => e === "immediateTransaction:call")).toHaveLength(1);

    const readStart = port.events.indexOf("transaction:run:start");
    const readEnd = port.events.indexOf("transaction:run:end");
    const writeStart = port.events.indexOf("immediateTransaction:run:start");
    const writeEnd = port.events.indexOf("immediateTransaction:run:end");
    expect(readStart).toBeGreaterThanOrEqual(0);
    expect(readEnd).toBeGreaterThan(readStart);
    // THE WRITE BEGINS ONLY AFTER THE READ TRANSACTION FULLY CLOSED: proof these are two SEQUENTIAL
    // transactions, not one merged one.
    expect(writeStart).toBeGreaterThan(readEnd);
    expect(writeEnd).toBeGreaterThan(writeStart);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// liveStageIndex — one read transaction for names+total (Codex round 5 follow-up, item 1b)
// ---------------------------------------------------------------------------
describe("liveStageIndex — one read transaction for names+total", () => {
  it("wraps liveStageNamesCapped and countLiveStages in ONE db.transaction(...) — the capped path exercises BOTH queries. STRUCTURAL ASSERTION, same technique as the standalone stageLookup transaction test above.", () => {
    const dir = mkTmp();
    const path = join(dir, "monet.db");
    const setup = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1 });
    let n = 0;
    const setupDb = raw(setup);
    const deps = { db: setupDb as never, newId: () => `extra-stage-${n++}`, nextSyncTimestamp: () => Date.now(), syncDeviceId: "d" };
    // Past STAGE_INDEX_CAP by a recognizable margin, so BOTH liveStageNamesCapped AND
    // countLiveStages actually run — countLiveStages is skipped entirely when retrieval isn't
    // capped, and a single-query call would not prove anything about the boundary BETWEEN two
    // reads. Same fast raw-insert technique the SQL-level retrieval bound suite above uses.
    const STAGE_COUNT = STAGE_INDEX_CAP + 5;
    for (let i = 0; i < STAGE_COUNT; i++) {
      const stage = upsertStage(deps, { stage: `bulk stage ${String(i).padStart(5, "0")}`, origin: "declaration" });
      const conceptId = `bulk-concept-${i}`;
      setupDb.prepare(
        `INSERT INTO concepts (id, slug, title, body, kind, status, circle, embedding)
         VALUES (?, ?, ?, ?, 'rule', 'active', 'default', '[]')`,
      ).run(conceptId, `bulk-slug-${i}`, `Bulk rule ${i}`, `Body ${i}`);
      setupDb.prepare(
        `INSERT INTO rule_bindings (concept_id, stage_id, severity, scope, model_tag, origin, circle, created_at, sync_updated_at, sync_revision)
         VALUES (?, ?, 'advisory', 'domain', NULL, 'import', 'default', ?, ?, 0)`,
      ).run(conceptId, stage.id, Date.now(), Date.now());
    }
    setup.close();

    const port = new TransactionLoggingStorage(path);
    const result = liveStageIndex(port, "default");
    port.close();

    expect(result.names).toHaveLength(STAGE_INDEX_CAP);
    expect(result.total).toBe(STAGE_COUNT); // sanity: this really is the capped, two-query path

    // EXACTLY ONE read transaction spans BOTH queries — not two separate, unwrapped statements
    // (which would reopen the same TOCTOU window round 4's standalone-stageLookup fix closed, just
    // for this function): a concurrent writer landing a rule bind/retire BETWEEN the names query
    // and the count query could otherwise make `total` describe a different instant than `names`.
    expect(port.events.filter((e) => e === "transaction:call")).toHaveLength(1);
    const readStart = port.events.indexOf("transaction:run:start");
    const readEnd = port.events.indexOf("transaction:run:end");
    expect(readStart).toBeGreaterThanOrEqual(0);
    expect(readEnd).toBeGreaterThan(readStart);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// SQL-level retrieval bounds (Codex round 2, item 2)
// ---------------------------------------------------------------------------
describe("evaluateStageLookup — SQL-level retrieval bounds", () => {
  it("caps rule count AND body length AND reason length IN RETRIEVAL — not just at the wire — while rulesTotal/rulesOutline keep an honest total", async () => {
    const c = core();
    // 250 rules on one stage: just past STAGE_LOOKUP_RULES_CAP (200), not the "300 x 1MB" scale —
    // enough to prove the SQL bound fires without a slow test. A handful of large bodies AND large
    // reasons (both over their SQL caps) prove retrieval itself truncates on both axes; the rest
    // stay small so the test stays fast.
    const RULE_COUNT = STAGE_LOOKUP_RULES_CAP + 50;
    const ids: string[] = [];
    for (let i = 0; i < RULE_COUNT; i++) {
      // A long reason is a LEGITIMATE, API-reachable shape (unlike the pathological whitespace-
      // prefixed one below) — advisory reasons carry no write-time length bound at all (review fix
      // — Codex round 3, item 1) — so this goes through store() directly, no raw SQL needed.
      const bigReason = i < 5 ? "r".repeat(STAGE_LOOKUP_REASON_CAP + 500) : undefined;
      const stored = await c.store(`Rule number ${i}.`, {
        kind: "rule", resolution: "forceNew",
        rule: { stage: "bulk stage", scope: "domain", ...(bigReason !== undefined ? { reason: bigReason } : {}) },
      });
      ids.push(stored.conceptId);
      const body = i < 5 ? "b".repeat(STAGE_LOOKUP_BODY_CAP + 500) : `short body ${i}`;
      raw(c).prepare(`UPDATE concepts SET body = ? WHERE id = ?`).run(body, stored.conceptId);
    }

    const r = c.stageLookup({ stage: "bulk stage" });
    expect(r.matched).toBe(true);
    // RETRIEVAL ITSELF is bounded (this is a direct engine call — no wire layer involved at all).
    expect(r.rules.length).toBeLessThanOrEqual(STAGE_LOOKUP_RULES_CAP);
    expect(r.rulesTotal).toBe(RULE_COUNT); // EXACT, via the engine's own COUNT(*) fallback
    // A large body came back TRUNCATED BY SQL (substr), not fetched-whole-then-discarded: capped at
    // EXACTLY STAGE_LOOKUP_BODY_CAP + 1 (the "+1 probe" — see gates.ts's own comment), never the
    // true STAGE_LOOKUP_BODY_CAP + 500 that was actually stored. EXACT length, not merely
    // `toBeLessThanOrEqual`: a loose bound here is exactly what let the two caps' bind params ship
    // silently SWAPPED once already (Codex round 3, item 1 follow-up) — both caps are "small
    // enough" that a swap still passes a `<=` check on either field.
    const bigBodyRule = r.rules.find((rule) => rule.body !== null && rule.body.length > 100);
    expect(bigBodyRule).toBeDefined();
    expect(bigBodyRule!.body).toHaveLength(STAGE_LOOKUP_BODY_CAP + 1);
    // SAME "+1 probe" SQL bound, now applied to `reason` too (review fix — Codex round 3, item 1).
    // Also EXACT, for the same swap-detecting reason as body just above.
    const bigReasonRule = r.rules.find((rule) => rule.reason !== null && rule.reason.length > 100);
    expect(bigReasonRule).toBeDefined();
    expect(bigReasonRule!.reason).toHaveLength(STAGE_LOOKUP_REASON_CAP + 1);
    // A compact outline for rules retrieval never even fetched — {conceptId, text} only, and every
    // id is real (drawn from this store, never fabricated or double-counted with `rules`).
    expect(r.rulesOutline).toBeDefined();
    expect(r.rulesOutline!.length).toBeGreaterThan(0);
    const shownIds = new Set(r.rules.map((rule) => rule.conceptId));
    for (const entry of r.rulesOutline!) {
      expect(ids).toContain(entry.conceptId);
      expect(shownIds.has(entry.conceptId)).toBe(false); // never re-describes an already-shown rule
      expect(typeof entry.text).toBe("string");
    }
    c.close();
  }, 30_000);

  it("reasonMissing stays correct across the SQL reason cap for a realistic reason, and the documented pathological edge behaves exactly as analyzed (Codex round 3, item 1)", async () => {
    const c = core();
    // ORDINARY CASE: a real, short blocking reason survives the cap untouched (substr of a string
    // shorter than the cap returns the whole string) — reasonMissing computes false exactly as it
    // did before retrieval was ever bounded.
    const ordinary = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a directory tree unattended.", severity: "blocking",
      reason: "there is no undo", scope: "domain",
    });
    if (ordinary.species !== "rule") throw new Error("unreachable");
    expect(c.stageLookup({ stage: "rm -rf" }).rules[0]).toMatchObject({
      reason: "there is no undo", reasonMissing: false,
    });

    // THE DOCUMENTED, ACCEPTED EDGE CASE (see STAGE_LOOKUP_REASON_CAP's own comment and
    // toGateRule's): a reason LONGER than the cap whose first CAP+1 characters are ALL whitespace,
    // with real content only beyond that boundary. Unreachable through declare() (which requires a
    // non-blank reason at write time) — relay-shaped, exactly like the whitespace-only case
    // elsewhere in this file — constructed directly so the analysis is verified empirically rather
    // than by inspection alone.
    const pathological = await c.declare({
      species: "rule", stage: "terraform apply", patterns: ["terraform apply"],
      content: "Confirm the plan before applying.", severity: "blocking",
      reason: "a placeholder reason", scope: "domain",
    });
    if (pathological.species !== "rule") throw new Error("unreachable");
    const adversarialReason = " ".repeat(STAGE_LOOKUP_REASON_CAP + 1) + "the real explanation, past the cap";
    raw(c).prepare(`UPDATE rule_bindings SET reason = ? WHERE concept_id = ?`).run(adversarialReason, pathological.conceptId);

    const rule = c.stageLookup({ stage: "terraform apply" }).rules[0]!;
    // SUBSTR'D to CAP + 1 chars, same "+1 probe" as body — so the delivered reason is ALL whitespace...
    expect(rule.reason).toHaveLength(STAGE_LOOKUP_REASON_CAP + 1);
    expect(rule.reason!.trim()).toBe("");
    // ...and reasonMissing, computed from THAT (possibly-truncated) value, reads this as missing —
    // the one documented divergence from computing it against the full, untruncated column. Wrong
    // for this doubly-pathological, unauthorable-by-design shape; correct for every real one above.
    expect(rule.reasonMissing).toBe(true);
    c.close();
  });

  it("leaves rulesTotal/rulesOutline undefined when retrieval was not capped — byte-identical to before this fix", async () => {
    const c = core();
    const stored = await c.store("A single rule.", { kind: "rule", rule: { stage: "small stage", scope: "domain" } });
    const r = c.stageLookup({ stage: "small stage" });
    expect(r.rules.map((rule) => rule.conceptId)).toEqual([stored.conceptId]);
    expect(r.rulesTotal).toBeUndefined();
    expect(r.rulesOutline).toBeUndefined();
    c.close();
  });
});

// ---------------------------------------------------------------------------
// the resident recognition cue
// ---------------------------------------------------------------------------
describe("liveStageIndex", () => {
  it("agent_context/prewarm omits stageIndex when there are no live stages", async () => {
    const c = core();
    expect(c.prewarm().stageIndex).toBeUndefined();
    c.close();
  });

  it("includes a stage on its first live rule, excludes it once retired, includes again on a fresh live rule", async () => {
    const c = core();
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", ...AGENT_RULE },
    });
    expect(c.prewarm().stageIndex).toEqual(["git force push"]);

    c.retireConcept(rule.conceptId);
    expect(c.prewarm().stageIndex).toBeUndefined(); // the only rule died — the stage is inert and absent

    await c.store("Never force-push to a shared branch, redux.", {
      kind: "rule", rule: { stage: "git force push", ...AGENT_RULE },
    });
    expect(c.prewarm().stageIndex).toEqual(["git force push"]);
    c.close();
  });

  it("excludes a stage whose only rule was SUPERSEDED (corrected away), not just retired", async () => {
    const c = core();
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    expect(c.prewarm().stageIndex).toEqual(["git force push"]);
    // A correction supersedes the rule AND births a successor bound to the same stage, so the
    // stage stays live through the successor — this step alone does not prove exclusion.
    const successor = await c.store("Force-push is fine on your own branch; never on a shared one.", {
      kind: "correction", attachTo: rule.conceptId,
    });
    expect(c.prewarm().stageIndex).toEqual(["git force push"]); // still live — the successor governs
    c.retireConcept(successor.conceptId);
    expect(c.prewarm().stageIndex).toBeUndefined(); // genuinely dead now: superseded AND retired
    c.close();
  });

  it("stageLookup's miss carries the exact index prewarm carries", async () => {
    const c = core();
    await c.store("Never force-push to a shared branch.", { kind: "rule", rule: { stage: "git force push", ...AGENT_RULE } });
    await c.store("Pull before you push.", { kind: "rule", rule: { stage: "git push", ...AGENT_RULE } });
    expect(c.stageLookup({ stage: "nope" }).stageIndex).toEqual(["git force push", "git push"]);
    c.close();
  });

  it("is circle-scoped, same as rule delivery: a rule in circle A does not put its stage in circle B's index", async () => {
    const c = core();
    await c.store("Never force-push to a shared branch.", {
      circle: "a", kind: "rule", rule: { stage: "git force push", ...AGENT_RULE },
    });
    expect(c.prewarm("a").stageIndex).toEqual(["git force push"]);
    expect(c.prewarm("b").stageIndex).toBeUndefined();
    c.close();
  });
});

// ---------------------------------------------------------------------------
// liveStageIndex — SQL-level retrieval bound (Codex round 3, item 2)
// ---------------------------------------------------------------------------
describe("liveStageIndex — SQL-level retrieval bound", () => {
  it("a stage with two simultaneously-live rules appears in the index exactly once — the JOIN-based rewrite still DISTINCTs by name (Codex round 3, item 2)", async () => {
    const c = core();
    await c.store("First rule for this stage.", { kind: "rule", rule: { stage: "git force push", scope: "domain" } });
    await c.store("Second rule for the same stage.", { kind: "rule", rule: { stage: "git force push", scope: "domain" } });
    expect(c.prewarm().stageIndex).toEqual(["git force push"]); // once, not twice
    c.close();
  });

  it("caps at STAGE_INDEX_CAP and reports an EXACT total once retrieval is actually capped — mirrors rulesTotal's honesty contract (Codex round 3, item 2)", () => {
    const c = core();
    let n = 0;
    const deps = { db: raw(c) as never, newId: () => `extra-stage-${n++}`, nextSyncTimestamp: () => Date.now(), syncDeviceId: "d" };
    const db = raw(c);
    // One past the cap — the same "+1 probe" boundary as the rules/body/reason caps. Raw INSERTs
    // (not store()/declare()) keep this fast: no embedding, just cheap prepared statements — three
    // per stage: upsertStage (the real minter, never reimplemented) plus one concept row and one
    // rule_binding row satisfying the exact NOT NULL/CHECK columns their own CREATE TABLE requires.
    const STAGE_COUNT = STAGE_INDEX_CAP + 1;
    for (let i = 0; i < STAGE_COUNT; i++) {
      const stage = upsertStage(deps, { stage: `bulk stage ${String(i).padStart(5, "0")}`, origin: "declaration" });
      const conceptId = `bulk-concept-${i}`;
      db.prepare(
        `INSERT INTO concepts (id, slug, title, body, kind, status, circle, embedding)
         VALUES (?, ?, ?, ?, 'rule', 'active', 'default', '[]')`,
      ).run(conceptId, `bulk-slug-${i}`, `Bulk rule ${i}`, `Body ${i}`);
      db.prepare(
        `INSERT INTO rule_bindings (concept_id, stage_id, severity, scope, model_tag, origin, circle, created_at, sync_updated_at, sync_revision)
         VALUES (?, ?, 'advisory', 'domain', NULL, 'import', 'default', ?, ?, 0)`,
      ).run(conceptId, stage.id, Date.now(), Date.now());
    }

    const r = c.stageLookup({ stage: "no such stage at all", circle: "default" });
    expect(r.matched).toBe(false);
    // RETRIEVAL ITSELF is bounded — a direct engine call, no wire layer involved.
    expect(r.stageIndex).toHaveLength(STAGE_INDEX_CAP);
    expect(r.stageIndexTotal).toBe(STAGE_COUNT); // EXACT, via the engine's own COUNT(*) fallback
    c.close();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// gateStats byMatcher
// ---------------------------------------------------------------------------
describe("gateStats retirement-candidate ordering", () => {
  function seededStore(): MonetCore {
    const c = core();
    const db = raw(c);
    let stageSeq = 0;
    const deps = { db: db as never, newId: () => `stable-stage-${stageSeq++}`, nextSyncTimestamp: () => 1, syncDeviceId: "d" };
    const stage = upsertStage(deps, { stage: "same-stage", origin: "declaration" });
    for (let index = 12; index >= 0; index--) {
      const conceptId = `stable-concept-${String(index).padStart(2, "0")}`;
      db.prepare(
        `INSERT INTO concepts (id, slug, title, body, kind, status, circle, embedding)
         VALUES (?, ?, 'Same title', 'Same body', 'rule', 'active', 'default', '[]')`,
      ).run(conceptId, `stable-${index}`);
      db.prepare(
        `INSERT INTO rule_bindings (concept_id, stage_id, severity, scope, model_tag, origin, circle, created_at, sync_updated_at, sync_revision)
         VALUES (?, ?, 'advisory', 'agent', 'old-model', 'import', 'default', 1, 1, 0)`,
      ).run(conceptId, stage.id);
    }
    return c;
  }

  it("selects the same capped prefix under duplicate model tags and titles", () => {
    const first = seededStore();
    const second = seededStore();
    const ids = (c: MonetCore) => gateStats(raw(c) as never, {
      circle: "default", windowDays: 30, runtimeModelTag: "current-model", exceptionLimit: 10,
    }).retirementCandidates.map((candidate) => candidate.conceptId);
    expect(ids(first)).toEqual(ids(second));
    expect(ids(first)).toEqual(Array.from({ length: 10 }, (_, index) => `stable-concept-${String(index).padStart(2, "0")}`));
    first.close();
    second.close();
  });
});

describe("gateStats byMatcher", () => {
  it("counts fires per matcher in the window; every other field stays mechanical-only (additive)", async () => {
    const c = core();
    await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    c.gate({ actionContext: "Bash:git push --force" });   // mechanical fire
    c.gate({ actionContext: "Bash:git status" });          // mechanical silence
    c.stageLookup({ stage: "git force push" });            // recognized hit
    c.stageLookup({ stage: "git force push" });            // recognized hit
    c.stageLookup({ stage: "no such stage" });             // recognized miss

    const stats = c.gateStats();
    expect([...stats.byMatcher].sort((a, b) => a.matcher.localeCompare(b.matcher))).toEqual([
      { matcher: "mechanical", count: 2 },
      { matcher: "recognized", count: 3 },
    ]);
    // ADDITIVE: the pre-existing fields are unmoved by, and exclude, the recognized rows.
    expect(stats).toMatchObject({ windowDays: 30, fires: 1, silences: 1, delivered: 1, windowTotal: 2, total: 2 });
    c.close();
  });
});

// ---------------------------------------------------------------------------
// the agent-facing surface
// ---------------------------------------------------------------------------
describe("MCP surface", () => {
  type McpContent = { content: Array<{ type: string; text: string }>; isError?: boolean };

  async function harness(c: MonetCore, opts: { modelTag?: string; autoPrewarm?: boolean } = {}) {
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, c, { autoPrewarm: false, checkpointNudge: false, ...opts });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await client.connect(ct);
    const call = async (tool: string, args: Record<string, unknown>): Promise<{ json: Record<string, unknown>; isError: boolean; text: string; prewarmText: string }> => {
      const r = (await client.callTool({ name: tool, arguments: args })) as McpContent;
      const text = r.content[0]!.text;
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // An error response is prose, not JSON — the caller asserts on `text` instead.
      }
      // content[1], when present, is the auto-prewarm block wrapSuccess appends (Codex round 3,
      // item 3's own test needs to see whether one was attached, and against what).
      const prewarmText = r.content[1]?.text ?? "";
      return { json, isError: r.isError === true, text, prewarmText };
    };
    return { call, client };
  }

  it("auto-prewarm carries the stage-index recognition cue with a capped honest tail", async () => {
    const c = core();
    for (let i = 0; i < 18; i++) {
      await c.store(`Rule number ${i}.`, {
        kind: "rule", resolution: "forceNew",
        rule: { stage: `stage-${String(i).padStart(2, "0")}`, scope: "domain" },
      });
    }
    const { call, client } = await harness(c, { autoPrewarm: true });
    const result = await call("memory_overview", {});

    expect(result.prewarmText).toContain("Stages you can recognize (ask stage_lookup): ");
    expect(result.prewarmText).toContain("stage-00");
    expect(result.prewarmText).toContain("(+3 more)");
    expect(result.prewarmText.length).toBeLessThan(1_500);

    await client.close();
    c.close();
  });

  it("auto-prewarm stage tail reports the true total past STAGE_INDEX_CAP", async () => {
    const c = core();
    let n = 0;
    const deps = { db: raw(c) as never, newId: () => `extra-stage-${n++}`, nextSyncTimestamp: () => Date.now(), syncDeviceId: "d" };
    const db = raw(c);
    const STAGE_COUNT = STAGE_INDEX_CAP + 100;
    for (let i = 0; i < STAGE_COUNT; i++) {
      const stage = upsertStage(deps, { stage: `bulk stage ${String(i).padStart(5, "0")}`, origin: "declaration" });
      const conceptId = `bulk-concept-${i}`;
      db.prepare(
        `INSERT INTO concepts (id, slug, title, body, kind, status, circle, embedding)
         VALUES (?, ?, ?, ?, 'rule', 'active', 'default', '[]')`,
      ).run(conceptId, `bulk-slug-${i}`, `Bulk rule ${i}`, `Body ${i}`);
      db.prepare(
        `INSERT INTO rule_bindings (concept_id, stage_id, severity, scope, model_tag, origin, circle, created_at, sync_updated_at, sync_revision)
         VALUES (?, ?, 'advisory', 'domain', NULL, 'import', 'default', ?, ?, 0)`,
      ).run(conceptId, stage.id, Date.now(), Date.now());
    }
    const { call, client } = await harness(c, { autoPrewarm: true });
    const result = await call("memory_overview", {});

    expect(result.prewarmText).toContain("Stages you can recognize (ask stage_lookup): ");
    expect(result.prewarmText).toContain(`(+${STAGE_COUNT - 15} more)`);
    expect(result.prewarmText).not.toContain("(+1985 more)");

    await client.close();
    c.close();
  }, 30_000);

  it("auto-prewarm preserves a non-empty stage cue for pathologically long names", async () => {
    const c = core();
    for (let i = 0; i < 15; i++) {
      const name = `stage-${String(i).padStart(2, "0")}-${"x".repeat(480)}`;
      await c.store(`Rule for stage ${i}.`, {
        kind: "rule", resolution: "forceNew", rule: { stage: name, scope: "domain" },
      });
    }
    const { call, client } = await harness(c, { autoPrewarm: true });
    const result = await call("memory_overview", {});

    expect(result.prewarmText).toContain("Stages you can recognize (ask stage_lookup): ");
    expect(result.prewarmText).toContain("stage-00");
    const tailMatch = result.prewarmText.match(/\(\+(\d+) more\)/);
    expect(tailMatch).not.toBeNull();
    const more = Number(tailMatch![1]);
    expect(more).toBeGreaterThan(0);
    expect(more).toBeLessThan(15);
    expect(result.prewarmText.length).toBeLessThanOrEqual(2_500);

    await client.close();
    c.close();
  });

  it("captures a rule and declares a blocking one, end to end", async () => {
    const c = core();
    const { call, client } = await harness(c, { modelTag: "host-supplied-model" });

    const stored = await call("memory_store", {
      content: "Never force-push to a shared branch.",
      kind: "rule",
      rule: { stage: "git force push", instance: "Bash:git push --force origin main", reason: "it destroys teammates' commits" },
    });
    expect(stored.isError).toBe(false);
    // The model tag came from the HOST, not from the agent — the agent never named one.
    expect(c.ruleBinding(stored.json.conceptId as string)).toMatchObject({
      severity: "advisory", scope: "agent", model_tag: "host-supplied-model",
    });

    const declared = await call("memory_declare", {
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a directory tree unattended.", severity: "blocking", reason: "there is no undo",
      declaredBy: "john",
    });
    expect(declared.isError).toBe(false);
    expect(declared.json).toMatchObject({ species: "rule" });
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules[0]).toMatchObject({ severity: "blocking" });

    await client.close();
    c.close();
  });

  it("rejects an oversized store circle before mutation", async () => {
    const c = core();
    const { call, client } = await harness(c);
    const before = c.conceptCount("default");
    const result = await call("memory_store", { content: "Must never be written.", circle: "x".repeat(257) });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("String must contain at most 256 character(s)");
    expect(c.conceptCount("default")).toBe(before);
    expect(raw(c).prepare(`SELECT COUNT(*) AS n FROM observations`).get()).toEqual({ n: 0 });

    await client.close();
    c.close();
  });

  it("memory_store omits resolutionMode and score for normal modes, but includes both for an ambiguous fork", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 0.99, tauAmbiguous: 0.1 });
    const { call, client } = await harness(c);

    const fresh = await call("memory_store", { content: "Verify the built artifact after source changes." });
    expect(fresh.isError).toBe(false);
    expect(fresh.json).not.toHaveProperty("resolutionMode");
    expect(fresh.json).not.toHaveProperty("score");

    const attached = await call("memory_store", { content: "Verify the built artifact after source changes." });
    expect(attached.isError).toBe(false);
    expect(attached.json.action).toBe("attached");
    expect(attached.json).not.toHaveProperty("resolutionMode");
    expect(attached.json).not.toHaveProperty("score");

    const direct = await call("memory_store", {
      content: "A second observation attached intentionally.", attachTo: fresh.json.conceptId,
    });
    expect(direct.isError).toBe(false);
    expect(direct.json).not.toHaveProperty("resolutionMode");
    expect(direct.json).not.toHaveProperty("score");

    const forced = await call("memory_store", { content: "Known distinct import row.", resolution: "forceNew" });
    expect(forced.isError).toBe(false);
    expect(forced.json).not.toHaveProperty("resolutionMode");
    expect(forced.json).not.toHaveProperty("score");

    const forked = await call("memory_store", { content: "After source changes, verify the artifact itself." });
    expect(forked.isError).toBe(false);
    expect(forked.json.resolutionMode).toBe("ambiguous-fork");
    expect(typeof forked.json.score).toBe("number");

    await client.close();
    c.close();
  });

  it("memory_store reports species-fork when rule evidence forks from a near-match fact", async () => {
    const c = new MonetCore(":memory:", {
      embedder: new ConstantEmbeddingProvider(), tauAttach: 0.5, tauAmbiguous: 0.2,
    });
    const { call, client } = await harness(c);
    const fact = await call("memory_store", { content: "Verify the artifact before promotion." });
    const rule = await call("memory_store", {
      content: "Verify the artifact before promotion.",
      kind: "rule",
      rule: { stage: "release promotion", scope: "domain" },
    });

    expect(rule.isError).toBe(false);
    expect(rule.json).toMatchObject({ action: "created", resolutionMode: "species-fork" });
    expect(typeof rule.json.score).toBe("number");
    expect(rule.json.nearMatchId).toBe(fact.json.conceptId);
    expect(rule.json.conceptId).not.toBe(fact.json.conceptId);

    await client.close();
    c.close();
  });

  // -------------------------------------------------------------------------
  // skeleton entrances over the real MCP wire: memory_declare (principle/preference) + memory_ratify
  // -------------------------------------------------------------------------
  it("memory_declare(species principle) over MCP: advisory acknowledgement without skeleton payload", async () => {
    const c = core();
    const { call, client } = await harness(c);
    const r = await call("memory_declare", {
      species: "principle",
      content: "Encode principles, not procedures.",
    });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ species: "principle" });
    expect(Array.isArray(r.json.advisories)).toBe(true);
    // Missing exitsEvidence is the one advisory this minimal call is guaranteed to carry.
    expect((r.json.advisories as Array<{ kind: string }>).some((a) => a.kind === "missing_exits_evidence")).toBe(true);
    expect(r.json).not.toHaveProperty("skeleton");
    expect(r.json).not.toHaveProperty("skeletonTruncated");
    expect(r.json).not.toHaveProperty("skeletonOmitted");
    expect(r.json).not.toHaveProperty("guidance");
    expect(r.json).not.toHaveProperty("instruction");
    await client.close();
    c.close();
  });

  it.each(["principle", "preference"] as const)(
    "memory_declare(species %s) discloses only an actual global-to-local narrowing in existing guidance",
    async (species) => {
      const c = resolvingCore();
      const { call, client } = await harness(c);
      const content = `A ${species} with an explicitly governed breadth transition.`;

      const global = await call("memory_declare", { species, content, circle: "*" });
      expect(global.isError).toBe(false);
      expect(global.json).not.toHaveProperty("guidance");
      expect(global.json).not.toHaveProperty("narrowedFromBreadth");

      const omitted = await call("memory_declare", { species, content });
      expect(omitted.isError).toBe(false);
      expect(omitted.json.conceptId).toBe(global.json.conceptId);
      expect(omitted.json).not.toHaveProperty("guidance");
      expect(c.skeleton("elsewhere").some((entry) => entry.conceptId === global.json.conceptId)).toBe(true);

      const stillGlobal = await call("memory_declare", { species, content, circle: "*" });
      expect(stillGlobal.isError).toBe(false);
      expect(stillGlobal.json).not.toHaveProperty("guidance");

      const narrowed = await call("memory_declare", { species, content, circle: "default" });
      expect(narrowed.isError).toBe(false);
      expect(narrowed.json.guidance).toContain(
        `BREADTH NARROWED: this ${species} was global (every circle) and now delivers only in its own circle — ` +
        `every OTHER circle stops receiving it. Tell the user plainly. Re-declare with circle="*" to restore it.`,
      );
      // The transition signal is internal plumbing; #113 keeps it out of the wire payload.
      expect(narrowed.json).not.toHaveProperty("narrowedFromBreadth");
      expect(c.skeleton("elsewhere").some((entry) => entry.conceptId === global.json.conceptId)).toBe(false);

      await client.close();
      c.close();
    },
  );

  it.each(["principle", "preference"] as const)(
    "memory_declare(species %s) does not inject the host modelTag, but still rejects one the caller supplied",
    async (species) => {
      const c = core();
      const { call, client } = await harness(c, { modelTag: "host-model" });

      const declared = await call("memory_declare", {
        species,
        content: `A ${species} survives a configured host model tag.`,
      });
      expect(declared.isError).toBe(false);
      expect(declared.json).toMatchObject({ species });

      const callerTagged = await call("memory_declare", {
        species,
        content: `A caller-tagged ${species} is invalid.`,
        modelTag: "caller-model",
      });
      expect(callerTagged.isError).toBe(true);
      expect(callerTagged.text).toMatch(new RegExp(`species '${species}' carries no modelTag`));

      await client.close();
      c.close();
    },
  );

  it("memory_ratify over MCP: approve with memberRuleIds returns an acknowledgement without skeleton", async () => {
    const c = core();
    const { call, client } = await harness(c);
    const principle = await call("memory_declare", { species: "principle", content: "A principle to ratify with members." });
    const rule = await call("memory_store", {
      content: "A member rule.", kind: "rule",
      rule: { stage: "some gate", scope: "domain" },
    });
    const r = await call("memory_ratify", {
      candidateId: principle.json.conceptId,
      verdict: "approve",
      memberRuleIds: [rule.json.conceptId],
      ratifiedBy: "john",
    });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ verdict: "approve", conceptId: principle.json.conceptId });
    expect(r.json.edgeIds).toHaveLength(1);
    expect(r.json).not.toHaveProperty("skeleton");
    expect(r.json).not.toHaveProperty("skeletonTruncated");
    expect(r.json).not.toHaveProperty("skeletonOmitted");
    expect(r.json).not.toHaveProperty("guidance");
    expect(r.json).not.toHaveProperty("instruction");
    await client.close();
    c.close();
  });

  /**
   * THE OUTCOME DISCLOSURES REACH THE WIRE (review fix — Codex 5-B round 4, R4-2, and R4-4's own
   * field riding the same discipline). The handler rebuilds its response from a fixed field list,
   * and that list omitted `impeachmentsClosed` — so an MCP caller whose ratification closed an
   * impeachment received a payload byte-identical to one that closed nothing, despite that field
   * being the in-band disclosure added for exactly that distinction. `extractionFlagsResolved` is
   * the second field of the same shape and is pinned here beside it so the two cannot drift apart.
   */
  it("memory_ratify over MCP carries impeachmentsClosed when the verdict closed one", async () => {
    const c = core();
    const { call, client } = await harness(c);
    const declared = await c.declare({ species: "principle", content: "Irreversible acts get a confirmation.", declaredBy: "john" });
    if (declared.species !== "principle") throw new Error("unreachable");
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    c.addLifecycleEdge({ family: "derivation", srcConceptId: declared.conceptId, dstConceptId: rule.conceptId, bornOf: "extraction" });
    // A correction kills the rule, which impeaches the parent — the reachable route to an open
    // impeachment that a `retire` verdict then closes (approve/re-ratify are refused while disputed).
    await c.store("Force-push is fine on your own branch; never on a shared one.", { kind: "correction", attachTo: rule.conceptId });

    const r = await call("memory_ratify", { candidateId: declared.conceptId, verdict: "retire", ratifiedBy: "john" });
    expect(r.isError).toBe(false);
    expect(r.json.impeachmentsClosed).toBe(1);

    // OMITTED, NEVER 0, when a verdict closed nothing — presence alone is the signal.
    const other = await call("memory_declare", { species: "principle", content: "Prefer the smallest reversible step." });
    const plain = await call("memory_ratify", { candidateId: other.json.conceptId, verdict: "re-ratify" });
    expect(plain.isError).toBe(false);
    expect(Object.keys(plain.json)).not.toContain("impeachmentsClosed");
    expect(Object.keys(plain.json)).not.toContain("extractionFlagsResolved");
    await client.close();
    c.close();
  });

  it("memory_ratify over MCP carries extractionFlagsResolved when the verdict answered a flagged pair", async () => {
    // The ambiguous band, so two near-matching rules at different stages fork into a flagged pair.
    const c = new MonetCore(":memory:", { tauAttach: 0.99, tauAmbiguous: 0.1 });
    const { call, client } = await harness(c);
    const first = await c.store("Verify the built artifact after the source changes.", {
      kind: "rule", rule: { stage: "docker build", instance: "Bash:docker build .", scope: "domain" },
    });
    const second = await c.store("After the source changes, verify the artifact itself.", {
      kind: "rule", rule: { stage: "npm install", instance: "Bash:npm install", scope: "domain" },
    });
    expect(c.overview("default").counts.extractionCandidates).toBe(1);
    const declared = await c.declare({
      species: "principle", content: "A build artifact is a snapshot; re-materialize after the source changes.", declaredBy: "john",
    });
    if (declared.species !== "principle") throw new Error("unreachable");

    const r = await call("memory_ratify", {
      candidateId: declared.conceptId, verdict: "approve",
      memberRuleIds: [first.conceptId, second.conceptId], ratifiedBy: "john",
    });
    expect(r.isError).toBe(false);
    expect(r.json.extractionFlagsResolved).toBe(1);
    expect(r.json.edgeIds).toHaveLength(2);
    expect(c.overview("default").counts.extractionCandidates).toBe(0);
    await client.close();
    c.close();
  });

  it("memory_ratify over MCP rejects a candidateId that is not kind principle/preference", async () => {
    const c = core();
    const { call, client } = await harness(c);
    const fact = await call("memory_store", { content: "An ordinary fact." });
    const r = await call("memory_ratify", { candidateId: fact.json.conceptId, verdict: "approve" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not 'principle' or 'preference'/);
    await client.close();
    c.close();
  });

  /** A live deny, declared the only way a deny can be born: by declaration. `circle: "*"` = global. */
  async function mcpDeny(c: MonetCore, content: string, stage: string, circle?: string) {
    const r = await c.declare({
      species: "rule", stage, patterns: [`Bash:${stage}`], content,
      severity: "blocking", reason: "there is no undo", declaredBy: "john", ...AGENT_RULE,
      ...(circle ? { circle } : {}),
    });
    if (r.species !== "rule") throw new Error("unreachable");
    return r;
  }

  /**
   * ISSUE #184's SECOND HALF. The move that stays legal — live circle to live circle — is still a
   * deny that stops firing where it was, and the response said only "Moved to X." Nothing else in
   * the payload names severity, so the caller had no way to know and the user was never told. This
   * is the mandatory-disclosure discipline memory_declare already carries for DENY REMOVED /
   * BREADTH NARROWED, extended one axis over at the same layer.
   */
  it("memory_reassign_circle discloses a relocated deny in single mode, and says nothing for an ordinary move", async () => {
    const c = core();
    const { call, client } = await harness(c);
    const deny = await mcpDeny(c, "Never delete a directory tree unattended.", "rm -rf");

    const moved = await call("memory_reassign_circle", { id: deny.conceptId, toCircle: "elsewhere" });
    expect(moved.isError).toBe(false);
    expect(moved.json.action).toBe("moved");
    const message = moved.json.message as string;
    expect(message).toContain("DENY RELOCATED");
    expect(message).toContain("no longer fires in the circle it left");
    expect(message).toContain("it now denies only in elsewhere");
    expect(message).toContain("Tell the user plainly");
    // The ordinary guidance still rides along — the disclosure precedes it, never replaces it.
    expect(message).toContain("Moved to elsewhere.");

    // A NON-DENY MOVE SAYS NOTHING: presence of the line is the signal, so it must not be noise.
    const fact = await c.store("An ordinary fact.", { kind: "fact" });
    const plain = await call("memory_reassign_circle", { id: fact.conceptId, toCircle: "elsewhere" });
    expect(plain.isError).toBe(false);
    expect(plain.json.action).toBe("moved");
    expect(plain.json.message as string).not.toContain("DENY RELOCATED");

    await client.close();
    c.close();
  });

  /**
   * WHAT THE DISCLOSURE MAY NOT DEPEND ON (review round 3). `wasCircleLocalLiveDeny` is frozen by the
   * reservation that performed the move; the ORIGIN is not — `reassignCircle` reads it off a `src`
   * row fetched before the transaction opens. Reproduced with a second connection moving the rule
   * default→staging during `bestMatches`: this line said "no longer fires in default" about a circle
   * that had already stopped firing, while `staging`, the circle this mutation actually emptied,
   * appeared nowhere in the response. Freezing a snapshot is NOT the fix — the same stale value has a
   * far worse consumer in `unwindConceptGraph`, and that whole family is #197 — so the disclosure
   * stops depending on the fact instead, in the batch instruction's own words. This pins that no
   * circle name stands where the origin used to.
   */
  it("memory_reassign_circle's single-mode disclosure names no origin circle — that fact is not frozen by the move", async () => {
    const c = core();
    const { call, client } = await harness(c);
    const deny = await mcpDeny(c, "Never delete a directory tree unattended.", "rm -rf");
    expect(c.circleOf(deny.conceptId)).toBe("default");

    const moved = await call("memory_reassign_circle", { id: deny.conceptId, toCircle: "elsewhere" });
    expect(moved.isError).toBe(false);
    const disclosure = (moved.json.message as string).split("Tell the user plainly")[0]!;
    expect(disclosure).toContain("DENY RELOCATED");
    expect(disclosure).toContain("no longer fires in the circle it left");
    // The DESTINATION is still named — `toCircle` is the caller's own argument, not a pre-transaction
    // read — and the origin is not named at all, by any spelling.
    expect(disclosure).toContain("it now denies only in elsewhere");
    expect(disclosure).not.toContain("default");

    await client.close();
    c.close();
  });

  it("memory_reassign_circle discloses relocated denies in batch mode, and the >25-item elision never drops that field", async () => {
    const c = core();
    const { call, client } = await harness(c);
    const deny = await mcpDeny(c, "Never delete a directory tree unattended.", "rm -rf");
    const fact = await c.store("An ordinary fact.", { kind: "fact" });

    const small = await call("memory_reassign_circle", { ids: [deny.conceptId, fact.conceptId], toCircle: "elsewhere" });
    expect(small.isError).toBe(false);
    expect(small.json.results).toHaveLength(2);
    expect(small.json.deniesRelocated).toEqual({
      rules: [{ conceptId: deny.conceptId }],
      instruction:
        "DENY RELOCATED: this blocking rule no longer fires in the circle it left — it now denies only in elsewhere. Tell the user plainly.",
    });

    // THE ELISION PATH IS THE ONE THAT MATTERS: a batch big enough to elide per-item results is
    // exactly where a silently relocated deny would disappear. 30 ordinary concepts + one deny.
    const bulkDeny = await mcpDeny(c, "Never rewrite published history.", "git push --force");
    const ids = [bulkDeny.conceptId];
    for (let i = 0; i < 30; i++) {
      ids.push((await c.store(`Bulk fact ${i}.`, { kind: "fact", resolution: "forceNew" })).conceptId);
    }
    const big = await call("memory_reassign_circle", { ids, toCircle: "attic" });
    expect(big.isError).toBe(false);
    expect(big.json.results).toBeUndefined();
    expect(big.json.note as string).toContain("per-item results elided");
    expect(big.json.deniesRelocated).toEqual({
      rules: [{ conceptId: bulkDeny.conceptId }],
      instruction:
        "DENY RELOCATED: this blocking rule no longer fires in the circle it left — it now denies only in attic. Tell the user plainly.",
    });

    await client.close();
    c.close();
  }, 30_000);

  /**
   * THE DISCLOSURE'S SUBJECT, NARROWED (review round 2). A breadth ('*') binding does not travel
   * with its concept, so for a global deny the line this handler was emitting — "no longer fires in
   * default, now denies only in elsewhere" — was simply untrue: the rule still denies in default,
   * in elsewhere, and everywhere else. A mandatory disclosure that can be false is worse than an
   * absent one, because the entire protocol here is that the line's PRESENCE is the signal.
   */
  it("memory_reassign_circle says NOTHING for a BREADTH-bound deny — single and batch — because the move costs it no delivery", async () => {
    const c = core();
    const { call, client } = await harness(c);
    const deny = await mcpDeny(c, "Never delete a directory tree unattended.", "rm -rf", BREADTH_CIRCLE);
    expect(c.ruleBinding(deny.conceptId)!.circle).toBe(BREADTH_CIRCLE);

    const moved = await call("memory_reassign_circle", { id: deny.conceptId, toCircle: "elsewhere" });
    expect(moved.isError).toBe(false);
    expect(moved.json.action).toBe("moved");
    expect(moved.json.message as string).not.toContain("DENY RELOCATED");
    // Because nothing about its delivery changed: the binding stayed global, and the deny still
    // fires in the circle its concept just left.
    expect(c.ruleBinding(deny.conceptId)!.circle).toBe(BREADTH_CIRCLE);
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: "default" }).rules
      .filter((r) => r.severity === "blocking")).toHaveLength(1);

    // BATCH MODE, same question — the field is absent entirely rather than present and empty.
    const batchDeny = await mcpDeny(c, "Never rewrite published history.", "git push --force", BREADTH_CIRCLE);
    const batch = await call("memory_reassign_circle", { ids: [batchDeny.conceptId], toCircle: "elsewhere" });
    expect(batch.isError).toBe(false);
    expect(batch.json.counts).toMatchObject({ moved: 1, error: 0 });
    expect(batch.json.deniesRelocated).toBeUndefined();
    expect(c.ruleBinding(batchDeny.conceptId)!.circle).toBe(BREADTH_CIRCLE);

    await client.close();
    c.close();
  });

  /**
   * The competing writer's own GateDeps, so its severity write goes through `bindRule` — the
   * production function every declaration's severity ruling lands in — rather than raw SQL. Called
   * directly, the same technique the bindRule TOCTOU tests above use, because only a SYNCHRONOUS
   * commit can land inside the synchronous window the race below opens.
   */
  const raceDeps = (c: MonetCore) => ({
    db: raw(c) as never, newId: () => "unused", nextSyncTimestamp: () => Date.now(), syncDeviceId: "connection-b",
  });

  /** Run `mid` from inside `c`'s next bestMatches scan — i.e. inside reassignCircle's pre-write gap. */
  function raceInsideReassign(c: MonetCore, mid: () => void) {
    type Matcher = { bestMatches(emb: Float32Array, circle: string, m: number): unknown[] };
    const original = (Object.getPrototypeOf(c) as Matcher).bestMatches;
    const state = { raced: false };
    const spy = vi.spyOn(c as unknown as Matcher, "bestMatches").mockImplementation((emb, circle, m) => {
      if (!state.raced) {
        state.raced = true;
        mid();
      }
      return original.call(c as unknown as Matcher, emb, circle, m);
    });
    return { state, spy };
  }

  /**
   * THE DISCLOSURE AND THE MOVE MUST READ ONE FROZEN FACT. The handler used to ask
   * `isCircleLocalLiveBlockingRule` just before calling `reassignCircle` — and reassignCircle runs a
   * full `bestMatches` vector scan before it opens `BEGIN IMMEDIATE`, so that answer was separated
   * from the move it describes by real work. One `.monet` file shared by the MCP server and a
   * `monet` CLI call is a supported topology (storage.ts), and a re-declaration of the rule's
   * severity landing in that window broke the disclosure in BOTH directions — this test and its
   * sibling below. The fix returns the fact from inside the reservation instead
   * (`ReassignResult.wasCircleLocalLiveDeny`), so there is one definition and no window at all.
   *
   * THE WORSE DIRECTION FIRST, and the one the reviewer did not name: a WITHDRAWN deny still
   * announced as relocated. A disclosure whose entire purpose is telling the user the truth about
   * deny coverage was stating the opposite — the same failure the breadth-bound narrowing above
   * fixed, arriving on a different axis.
   *
   * The window is opened deliberately rather than approximated, the same discipline the
   * archived-destination race test earlier in this file uses: the second connection commits from
   * inside `bestMatches`, which is the work that actually sits in the gap.
   */
  it("memory_reassign_circle says NOTHING when a second connection withdrew the deny mid-move — the disclosure never asserts protection that no longer exists", async () => {
    const dbPath = join(mkTmp(), "relocate-downgrade.db");
    const a = new MonetCore(dbPath);
    const b = new MonetCore(dbPath); // the competing writer: its own connection to the same file
    const { call, client } = await harness(a);
    const deny = await mcpDeny(a, "Never delete a directory tree unattended.", "rm -rf");
    const stageId = a.ruleBinding(deny.conceptId)!.stage_id;
    // Blocking when the caller asked — which is the premise: the old pre-call read saw exactly this.
    expect(a.ruleBinding(deny.conceptId)!.severity).toBe("blocking");

    const { state, spy } = raceInsideReassign(a, () => {
      bindRule(raceDeps(b), {
        conceptId: deny.conceptId, stageId, severity: "advisory", scope: "agent",
        modelTag: "test-model-1", origin: "declaration", declaredBy: "john", circle: "default",
      }, "replace");
    });

    const moved = await call("memory_reassign_circle", { id: deny.conceptId, toCircle: "live-dest" });
    // The withdrawal necessarily landed BEFORE the reservation opened: bestMatches runs first.
    expect(state.raced).toBe(true);
    expect(moved.isError).toBe(false);
    expect(moved.json.action).toBe("moved");
    // THE LIE THAT MUST NOT BE TOLD: "it now denies only in live-dest" about a rule that denies
    // nowhere. A mandatory disclosure stating the opposite of the truth is worse than an absent one.
    expect(moved.json.message as string).not.toContain("DENY RELOCATED");
    // ...and the silence is accurate: advisory now, and no deny fires in either circle.
    expect(a.ruleBinding(deny.conceptId)!.severity).toBe("advisory");
    for (const circle of ["default", "live-dest"]) {
      expect(a.gate({ actionContext: "Bash:rm -rf /tmp/x", circle }).rules
        .filter((r) => r.severity === "blocking")).toHaveLength(0);
    }
    // The ordinary guidance is untouched — silence is about the disclosure, not the response.
    expect(moved.json.message as string).toContain("Moved to live-dest.");

    spy.mockRestore();
    await client.close();
    a.close();
    b.close();
  }, 30_000);

  it("memory_reassign_circle DISCLOSES a deny a second connection minted mid-move — the omission direction of the same window", async () => {
    const dbPath = join(mkTmp(), "relocate-escalate.db");
    const a = new MonetCore(dbPath);
    const b = new MonetCore(dbPath);
    const { call, client } = await harness(a);
    // Advisory at the moment the caller asked, so the old pre-call read said "nothing to disclose".
    const rule = await a.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a directory tree unattended.", reason: "there is no undo",
      declaredBy: "john", ...AGENT_RULE,
    });
    if (rule.species !== "rule") throw new Error("unreachable");
    const stageId = a.ruleBinding(rule.conceptId)!.stage_id;
    expect(a.ruleBinding(rule.conceptId)!.severity).toBe("advisory");

    const { state, spy } = raceInsideReassign(a, () => {
      bindRule(raceDeps(b), {
        conceptId: rule.conceptId, stageId, severity: "blocking", scope: "agent",
        modelTag: "test-model-1", origin: "declaration", declaredBy: "john",
        reason: "there is no undo", circle: "default",
      }, "replace");
    });

    const moved = await call("memory_reassign_circle", { id: rule.conceptId, toCircle: "live-dest" });
    expect(state.raced).toBe(true);
    expect(moved.isError).toBe(false);
    expect(moved.json.action).toBe("moved");
    const message = moved.json.message as string;
    expect(message).toContain("DENY RELOCATED");
    expect(message).toContain("no longer fires in the circle it left");
    expect(message).toContain("it now denies only in live-dest");
    // ...and the disclosure is accurate: a real deny stopped covering `default` and covers live-dest.
    expect(a.ruleBinding(rule.conceptId)).toMatchObject({ severity: "blocking", circle: "live-dest" });
    expect(a.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: "default" }).rules
      .filter((r) => r.severity === "blocking")).toHaveLength(0);
    expect(a.gate({ actionContext: "Bash:rm -rf /tmp/x", circle: "live-dest" }).rules
      .filter((r) => r.severity === "blocking")).toHaveLength(1);

    spy.mockRestore();
    await client.close();
    a.close();
    b.close();
  }, 30_000);

  it("measures declare and ratify as complete acknowledgement envelopes", async () => {
    const c = core();
    const { call, client } = await harness(c);
    await seedRatifiedPrinciples(c, 300, (i) => `Principle number ${i} ${"x".repeat(400)}`);

    for (const r of [
      await call("memory_declare", { species: "principle", content: "One more principle." }),
      await call("memory_ratify", { candidateId: c.skeleton()[0]!.conceptId, verdict: "re-ratify" }),
    ]) {
      expect(r.isError).toBe(false);
      const parsed = JSON.parse(r.text) as Record<string, unknown>;
      expect(r.text.length).toBeLessThanOrEqual(40_000);
      expect(parsed).not.toHaveProperty("skeleton");
      expect(parsed).not.toHaveProperty("skeletonTruncated");
      expect(parsed).not.toHaveProperty("skeletonOmitted");
    }
    await client.close();
    c.close();
  }, 30_000);

  /**
   * BOTH DISCLOSURES, ONE CALL (Codex round 11, item 7, P2). The guidance string used to be built as
   * an if/else-if chain — `r.downgraded ? "DENY REMOVED..." : r.narrowedFromBreadth ? "BREADTH
   * NARROWED..." : ...` — so a single declare() that BOTH downgrades severity (blocking → advisory)
   * AND narrows breadth (circle '*' → local) in the SAME call short-circuited past the narrowing
   * branch the moment `downgraded` was true, silently swallowing the BREADTH NARROWED disclosure even
   * though the underlying `narrowedFromBreadth` field itself (spread from declare()'s own response,
   * computed independently of `downgraded` in engine.ts) was present and true the whole time.
   */
  it("a single declare() that BOTH downgrades severity AND narrows breadth in the SAME call discloses BOTH — DENY REMOVED first, then BREADTH NARROWED (Codex round 11, item 7)", async () => {
    const c = new MonetCore(":memory:", {}); // dedup ENABLED — the second declare() must resolve onto the SAME concept by content match alone, matching round 10's own "re-aiming" test precedent
    const { call, client } = await harness(c);

    const first = await call("memory_declare", {
      circle: BREADTH_CIRCLE, species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a directory tree unattended.", severity: "blocking", reason: "there is no undo",
      scope: "domain", // domain, not the "agent" default — sidesteps the modelTag requirement entirely, irrelevant to what this test targets
    });
    expect(first.isError).toBe(false);
    // NOT `first.json.circle` — that field is deliberately the HOME circle for prewarm, never the
    // breadth marker itself (Codex round 3, item 3's own fix; see that test's own comment: "the
    // binding ruling still reaches declare() as '*'"). The true ruling is read directly off the
    // engine, matching that test's own established pattern.
    expect(c.ruleBinding((first.json as { conceptId: string }).conceptId)!.circle).toBe(BREADTH_CIRCLE);

    // ONE ACT, BOTH AXES: severity blocking → advisory (a downgrade) AND circle '*' → 'default' (a
    // narrowing), in the identical call — nothing in declare() refuses combining the two. 'default'
    // NAMED EXPLICITLY, not a DIFFERENT circle like 'project': the concept's own HOME already
    // resolved to the constructor's implicit default ("default", no defaultCircle override above) the
    // moment the first call declared it with circle: '*' — matching "PATH 1 — breadth"'s own
    // established precedent test exactly (same construction, same resolved home). Naming a
    // genuinely DIFFERENT circle here would resolve to a DIFFERENT concept's home instead of this
    // one's, minting a second concept there rather than re-aiming this one — caught by this test's
    // own first draft doing exactly that (action: "created" twice, not "created" then a re-aim).
    const combined = await call("memory_declare", {
      circle: "default", species: "rule", stage: "rm -rf",
      content: "Never delete a directory tree unattended.", severity: "advisory", scope: "domain",
    });
    expect(combined.isError).toBe(false);
    expect(combined.json.downgraded).toBe(true);
    expect(combined.json.narrowedFromBreadth).toBe(true);
    const guidance = combined.json.guidance as string;
    expect(guidance).toContain("DENY REMOVED");
    expect(guidance).toContain("BREADTH NARROWED");
    // ORDER: severity's own disclosure first, matching the coordinator's own field precedence.
    expect(guidance.indexOf("DENY REMOVED")).toBeLessThan(guidance.indexOf("BREADTH NARROWED"));

    await client.close();
    c.close();
  });

  /**
   * THE MCP-LAYER HALF OF THE BREADTH-NARROWING FIX (Codex round 2, item 1) — a DIFFERENT bug from a
   * DIFFERENT layer than the engine-side "PATH 1 — breadth" tests above: this handler used to call
   * `scope(circle)` unconditionally, which resolves an omitted circle to the session default BEFORE
   * `core.declare()` is ever invoked — turning "the caller said nothing" into "the caller explicitly
   * named the default" on the wire, which declare() then has no way to tell apart from a real
   * ruling. Exercised over the actual MCP client/server transport, not a direct engine call, because
   * that eager resolution lived in the handler, not in declare() itself.
   */
  it("memory_declare's own handler does not default-fill circle before declare() sees it — re-declaring a global rule over MCP, with no circle argument, keeps it global (Codex round 2, item 1)", async () => {
    const c = new MonetCore(":memory:", {}); // dedup ENABLED — memory_declare exposes no attachTo, so a restatement must resolve onto the SAME concept by content match alone
    const { call, client } = await harness(c);
    const CONTENT = "Never install without a lockfile present.";

    const first = await call("memory_declare", {
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"], scope: "domain",
      content: CONTENT, severity: "blocking", reason: "an unlocked install can drift", circle: "*",
    });
    expect(first.isError).toBe(false);
    const firstConceptId = (first.json as { conceptId: string }).conceptId;
    expect(c.ruleBinding(firstConceptId)!.circle).toBe(BREADTH_CIRCLE);

    // Re-declared over MCP with NO circle argument at all — the exact call shape a caller restating
    // a rule's text (a typo fix, an added detail) would naturally make, with no reason to think
    // "circle" is even relevant to what they are doing.
    const again = await call("memory_declare", {
      species: "rule", stage: "npm install", content: CONTENT, scope: "domain",
      severity: "blocking", reason: "an unlocked install can drift",
    });
    expect(again.isError).toBe(false);
    const againJson = again.json as { conceptId: string; narrowedFromBreadth?: boolean };
    expect(againJson.conceptId).toBe(firstConceptId); // same rule, restated — not a new one
    // STILL GLOBAL — the handler-level bug this fix closes would have silently narrowed this to the
    // session default the moment `circle` was omitted from the wire call.
    expect(c.ruleBinding(firstConceptId)!.circle).toBe(BREADTH_CIRCLE);
    expect(againJson.narrowedFromBreadth).toBeUndefined();
    expect(c.gate({ actionContext: "Bash:npm install", circle: "a-circle-this-test-never-otherwise-touches" }).rules.map((r) => r.conceptId))
      .toEqual([firstConceptId]);

    await client.close();
    c.close();
  });

  /**
   * THE HANDLER USED '*' FOR PREWARM AND THE RESPONSE'S OWN CIRCLE TOO (Codex round 3, item 3) — not
   * only for the binding ruling (round 2, item 1 already fixed that half). '*' is a valid ruling for
   * declare()'s own `circle` input, but it is never a real circle capturePrewarmSnapshot or a
   * response's `circle` field can operate against: the rule's CONCEPT always lives at the caller's
   * own default circle, never at the breadth marker. Verified here against a store with REAL prior
   * content in the default circle — capturePrewarmSnapshot('*') would find nothing there (nothing
   * can live in '*') and silently produce an empty block regardless of what the default circle
   * holds, which is indistinguishable from "there was nothing to show" unless the test controls for
   * it directly, as this one does.
   */
  it("memory_declare with circle '*' resolves a HOME circle for prewarm and the response, never '*' itself — the binding ruling still reaches declare() as '*' (Codex round 3, item 3)", async () => {
    const c = new MonetCore(":memory:", { defaultCircle: "the-real-default" });
    // A live stage in the default circle gives resident prewarm an orientation cue to render.
    await c.store("Check the lockfile before installing.", {
      kind: "rule",
      rule: { stage: "dependency install", scope: "domain" },
    });
    const { call, client } = await harness(c, { autoPrewarm: true });

    const declared = await call("memory_declare", {
      species: "rule", stage: "npm install", patterns: ["Bash:npm install"], scope: "domain",
      content: "Never install without a lockfile present.", severity: "blocking",
      reason: "an unlocked install can drift", circle: "*",
    });
    expect(declared.isError).toBe(false);
    const conceptId = (declared.json as { conceptId: string }).conceptId;

    // THE RULING still reaches declare() as '*' — round 2's own fix, unweakened by this one.
    expect(c.ruleBinding(conceptId)!.circle).toBe(BREADTH_CIRCLE);
    expect(c.gate({ actionContext: "Bash:npm install", circle: "a-circle-this-test-never-configured" }).rules.map((r) => r.conceptId))
      .toEqual([conceptId]);

    // THE RESPONSE'S OWN `circle` FIELD names the HOME circle, honestly — where the CONCEPT
    // actually lives — never the breadth marker.
    expect(declared.json.circle).toBe("the-real-default");

    // PREWARM WAS CAPTURED AGAINST THE HOME CIRCLE, not '*': non-empty because the default circle
    // has a live stage cue. Pre-fix, capturePrewarmSnapshot('*') would find no home-circle stages.
    expect(declared.prewarmText.length).toBeGreaterThan(0);

    await client.close();
    c.close();
  });

  it("lets the HOST tag win over one the agent supplied", async () => {
    const c = core();
    const { call, client } = await harness(c, { modelTag: "host-model" });
    // Model identity is a property of the RUNTIME. A model that misreports (or guesses) its own id
    // would otherwise file its compensation under another model's tag, and the retirement rule
    // would then retire the wrong ones — a boundary that must not rest on self-knowledge.
    const stored = await call("memory_store", {
      content: "A compensation.", kind: "rule",
      rule: { stage: "git force push", instance: "Bash:git push --force", modelTag: "agent-claimed-model" },
    });
    expect(c.ruleBinding(stored.json.conceptId as string)!.model_tag).toBe("host-model");

    const declared = await call("memory_declare", {
      species: "rule", stage: "rm -rf", content: "Another compensation.", modelTag: "agent-claimed-model",
    });
    expect(declared.isError).toBe(false);
    expect(c.ruleBinding((declared.json as { conceptId: string }).conceptId)!.model_tag).toBe("host-model");
    await client.close();
    c.close();
  });

  it("falls back to the agent's tag only when the host supplies none", async () => {
    const c = core();
    const prior = process.env.MONET_MODEL_TAG;
    delete process.env.MONET_MODEL_TAG;
    try {
      const { call, client } = await harness(c); // no host tag at all
      const stored = await call("memory_store", {
        content: "A compensation.", kind: "rule",
        rule: { stage: "git force push", instance: "Bash:git push --force", modelTag: "agent-claimed-model" },
      });
      expect(stored.isError).toBe(false);
      expect(c.ruleBinding(stored.json.conceptId as string)!.model_tag).toBe("agent-claimed-model");
      await client.close();
    } finally {
      if (prior !== undefined) process.env.MONET_MODEL_TAG = prior;
    }
    c.close();
  });

  it("captures with the LIVE runtime tag, not the one frozen at registration — a switch after registration is honored immediately by BOTH capture handlers (Codex round 3, item 4)", async () => {
    const c = core();
    const { call, client } = await harness(c, { modelTag: "model-a" });
    // A host that changes which model it is running mid-session calls setRuntimeModelTag directly
    // — registration ran ONCE, at server start, and its closure-captured copy of "model-a" must not
    // be what capture stamps from here on. gate()/stageLookup() already read this live; capture did
    // not, before this fix.
    c.setRuntimeModelTag("model-b");

    const stored = await call("memory_store", {
      content: "Never force-push to a shared branch.", kind: "rule",
      rule: { stage: "git force push", instance: "Bash:git push --force origin main" },
    });
    expect(stored.isError).toBe(false);
    expect(c.ruleBinding(stored.json.conceptId as string)!.model_tag).toBe("model-b");
    // IMMEDIATELY deliverable via BOTH read paths, with no explicit runtimeModelTag override — both
    // already resolved `this.runtimeModelTag` live before this fix; what was missing is CAPTURE
    // catching up to them. Before the fix this rule was stamped "model-a" and would be silently
    // filtered out of both calls below (captured, then instantly invisible).
    expect(c.gate({ actionContext: "Bash:git push --force origin main" }).rules.map((r) => r.conceptId))
      .toContain(stored.json.conceptId);
    expect(c.stageLookup({ stage: "git force push" }).rules.map((r) => r.conceptId))
      .toContain(stored.json.conceptId);

    // memory_declare's capture handler carries the identical fix.
    const declared = await call("memory_declare", {
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a directory tree unattended.", severity: "blocking", reason: "there is no undo",
    });
    expect(declared.isError).toBe(false);
    expect(c.ruleBinding((declared.json as { conceptId: string }).conceptId)!.model_tag).toBe("model-b");

    await client.close();
    c.close();
  });

  it("gives memory_store NO WAY to name a severity at all — deny power is not in its vocabulary", async () => {
    const c = core();
    const { client } = await harness(c);
    const { tools } = await client.listTools();
    const store = tools.find((t) => t.name === "memory_store")!;
    const ruleSchema = (store.inputSchema.properties as Record<string, { properties?: Record<string, unknown> }>).rule;
    // EXACT LIST, not a `not.toContain("severity")` — the point is that the vocabulary itself has no
    // door to deny power, so any NEW field added here has to be re-examined against that claim
    // rather than slipping in under a negative assertion. `projectedFromPrincipleId` (slice 5-B) is
    // the one addition since, and it is refused outright in combination with blocking severity —
    // "no agent, and NO PROJECTION, can self-assign deny power" (see the refusal test below).
    expect(Object.keys(ruleSchema.properties ?? {}).sort())
      .toEqual(["instance", "modelTag", "projectedFromPrincipleId", "reason", "scope", "stage"]);
    // ...while memory_declare does carry it, and says so.
    const declare = tools.find((t) => t.name === "memory_declare")!;
    expect(Object.keys(declare.inputSchema.properties as object)).toContain("severity");
    expect(declare.description).toMatch(/blocking/);
    await client.close();
    c.close();
  });

  it("projects a rule from a principle and reports the extraction candidate a rule birth flagged (5-B)", async () => {
    // SHIPPING-ISH BAND: the extraction flag rides a fork's near-match, so this core is tuned the
    // same way the 5-B engine block's is. Everything else goes over the real MCP wire.
    const c = new MonetCore(":memory:", { tauAttach: 0.99, tauAmbiguous: 0.1 });
    const { call, client } = await harness(c, { modelTag: "m1" });

    const principle = await c.declare({ species: "principle", content: "A build artifact is a snapshot; re-materialize after the source changes." });
    if (principle.species !== "principle") throw new Error("unreachable");

    // PROJECTION over the wire — the empty-gate moment's own write.
    const projected = await call("memory_store", {
      content: "Rebuild the image before deploying after a lockfile change.",
      kind: "rule",
      rule: { stage: "docker build", instance: "Bash:docker build .", scope: "domain", projectedFromPrincipleId: principle.conceptId },
    });
    expect(projected.isError).toBe(false);
    expect(c.ruleBinding(projected.json.conceptId as string)!.origin).toBe("projection");

    // A REFUSAL reaches the caller as an actionable error, not a constraint violation.
    const refused = await call("memory_store", {
      content: "Something else entirely.",
      kind: "rule", rule: { stage: "docker push", scope: "domain", projectedFromPrincipleId: "no-such-concept" },
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/does not exist: a projected rule names the skeleton principle/);

    // EXTRACTION CANDIDATE on the store response, omitted-when-absent like every optional field.
    const first = await call("memory_store", {
      content: "Verify the built artifact after the source changes.",
      kind: "rule", rule: { stage: "terraform apply", instance: "Bash:terraform apply", scope: "domain" },
    });
    const second = await call("memory_store", {
      content: "After the source changes, verify the artifact itself.",
      kind: "rule", rule: { stage: "npm install", instance: "Bash:npm install", scope: "domain" },
    });
    expect(second.json.extractionCandidate).toMatchObject({ pairedRuleId: first.json.conceptId });
    expect(first.json.extractionCandidate).toBeUndefined();

    await client.close();
    c.close();
  });

  /**
   * THE ADVERTISED EXIT (review fix — Codex 5-B round 1, F5). 5-B widened the engine's pair
   * dismissal to every pair-flag edge type, but left the MCP contract describing possible-duplicate
   * dismissal alone: an agent reading `memory_resolve` had no advertised way to remove an
   * `extractionCandidate`, and one that tried the pair arguments anyway got back
   * `action: "duplicate-pair-dismissed"` — a wire response naming the wrong flag. A flag with no
   * documented exit is a flag with no exit.
   */
  it("advertises pair-flag dismissal for BOTH flag types, and names the act honestly (5-B)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 0.99, tauAmbiguous: 0.1 });
    const { call, client } = await harness(c, { modelTag: "m1" });

    const { tools } = await client.listTools();
    const resolve = tools.find((t) => t.name === "memory_resolve")!;
    expect(resolve.description).toMatch(/PAIR-FLAG DISMISSAL/i);
    expect(resolve.description).toMatch(/extraction[- ]candidate/i);
    // One dismissal answers both questions about a pair, and the description says so rather than
    // leaving an agent to discover it.
    expect(resolve.description).toMatch(/both/i);
    const pairFields = resolve.inputSchema.properties as Record<string, { description?: string }>;
    expect(pairFields.conceptAId!.description).toMatch(/extraction[- ]candidate/i);
    expect(pairFields.conceptBId!.description).toMatch(/extraction[- ]candidate/i);
    // ...and the surface an agent finds the pair on says the list exists.
    expect(tools.find((t) => t.name === "memory_overview")!.description).toMatch(/extractionCandidates/);

    const first = await call("memory_store", {
      content: "Verify the built artifact after the source changes.",
      kind: "rule", rule: { stage: "terraform apply", instance: "Bash:terraform apply", scope: "domain" },
    });
    const second = await call("memory_store", {
      content: "After the source changes, verify the artifact itself.",
      kind: "rule", rule: { stage: "npm install", instance: "Bash:npm install", scope: "domain" },
    });
    expect(second.json.extractionCandidate).toBeDefined();
    expect(c.overview("default").counts.extractionCandidates).toBe(1);

    const dismissed = await call("memory_resolve", { conceptAId: first.json.conceptId, conceptBId: second.json.conceptId });
    expect(dismissed.isError).toBe(false);
    // NOT "duplicate-pair-dismissed": this call dismissed an extraction candidate as well, and the
    // action string is what an agent logs and branches on.
    expect(dismissed.json.action).toBe("pair-flags-dismissed");
    expect(c.overview("default").counts.extractionCandidates).toBe(0);
    expect(c.overview("default").counts.possibleDuplicates).toBe(0);

    await client.close();
    c.close();
  });

  it("bounds a correction acknowledgement with many impeached parents and reports the omitted count", async () => {
    const c = new MonetCore(":memory:", { embedder: new ConstantEmbeddingProvider() });
    const { call, client } = await harness(c);
    const rule = await c.store("Never promote an unverified artifact.", {
      kind: "rule", rule: { stage: "release promotion", scope: "domain" },
    });
    const db = raw(c);
    const embedding = (db.prepare(`SELECT embedding FROM concepts WHERE id = ?`).get(rule.conceptId) as { embedding: string }).embedding;
    const insertConcept = db.prepare(
      `INSERT INTO concepts (id, slug, title, body, kind, embedding, support_count, version, dirty, circle)
       VALUES (?, ?, ?, ?, 'principle', ?, 1, 0, 1, 'default')`,
    );
    const insertRatification = db.prepare(
      `INSERT INTO ratifications (id, subject_concept_id, verdict, packet, ratified_by, circle, created_at, sync_updated_at)
       VALUES (?, ?, 'approve', NULL, 'fixture', 'default', ?, ?)`,
    );
    for (let i = 0; i < 80; i++) {
      const id = `many-parent-${String(i).padStart(3, "0")}`;
      insertConcept.run(id, id, `Parent ${i}`, `Parent principle ${i}`, embedding);
      insertRatification.run(`many-parent-rat-${i}`, id, i + 1, i + 1);
      c.addLifecycleEdge({
        family: "derivation", srcConceptId: id, dstConceptId: rule.conceptId,
        bornOf: "extraction", eventRef: `fixture-${i}`,
      });
    }

    const corrected = await call("memory_store", {
      content: "Verify the artifact, then promote it.", kind: "correction", attachTo: rule.conceptId,
    });
    if (corrected.isError) throw new Error(corrected.text);
    expect(corrected.json.action).toBe("created");
    const succession = corrected.json.ruleSuccession as {
      successorRuleId: string; impeachedPrincipleIds: string[]; impeachedPrincipleIdsOmitted?: number;
    };
    expect(succession.impeachedPrincipleIds).toHaveLength(25);
    expect(succession.impeachedPrincipleIdsOmitted).toBe(55);
    expect(await c.getConcept(succession.successorRuleId)).toBeDefined();
    expect(JSON.stringify(corrected.json).length).toBeLessThan(40_000);

    await client.close();
    c.close();
  });

  it("announces a disputed parent principle on stage_lookup, and documents its any-parent meaning (5-B)", async () => {
    const c = core();
    const { call, client } = await harness(c, { modelTag: "m1" });
    const { tools } = await client.listTools();
    const lookupDescription = tools.find((tool) => tool.name === "stage_lookup")!.description;
    expect(lookupDescription).toContain("`parentDisputed:true` means `disputedParentIds` should be memory_fetched");
    // The named ids provide an MCP recovery path; the projected parent remains display-only.
    expect(lookupDescription).toContain("projectedFromPrincipleId is only the display parent");
    // PR #112 round 10: the fetch tool's own contract names the exact resolver call shape — an
    // ambiguous "id" failed memory_resolve's schema before the corrected response note was ever read.
    const fetchDescription = tools.find((tool) => tool.name === "memory_fetch")!.description;
    expect(fetchDescription).toContain("memory_resolve({ contradictionId: openContradictions[i].id })");
    expect(fetchDescription).toContain("Normal concepts return `body` and `observationCount`");
    expect(fetchDescription).toContain("evidence appears only with observations:true");
    expect(fetchDescription).toContain("`needsSynthesis:true`");
    expect(fetchDescription).toContain("Source concepts instead return title, sourcePath/sourceId, and outline");
    const principle = await c.declare({ species: "principle", content: "Irreversible acts get a confirmation." });
    if (principle.species !== "principle") throw new Error("unreachable");
    const projected = await c.store("Confirm the target namespace before deleting a release.", {
      kind: "rule",
      rule: { stage: "helm delete", instance: "Bash:helm delete my-release", scope: "domain", projectedFromPrincipleId: principle.conceptId },
    });

    const before = await call("stage_lookup", { stage: "helm delete" });
    const beforeRule = (before.json.rules as Array<Record<string, unknown>>)[0]!;
    expect(beforeRule.projectedFromPrincipleId).toBe(principle.conceptId);
    expect(Object.keys(beforeRule)).not.toContain("parentDisputed");

    // Impeach the parent through a SIBLING rule, so the rule being looked up is itself untouched.
    const sibling = await c.store("Snapshot the volume before deleting a stateful set.", {
      kind: "rule", rule: { stage: "kubectl delete", instance: "Bash:kubectl delete sts x", scope: "domain", projectedFromPrincipleId: principle.conceptId },
    });
    const corrected = await call("memory_store", {
      content: "Snapshot the volume AND drain the node before deleting a stateful set.",
      kind: "correction", attachTo: sibling.conceptId,
    });
    // The impeachment is disclosed on the write that caused it.
    expect((corrected.json.ruleSuccession as { impeachedPrincipleIds?: string[] }).impeachedPrincipleIds)
      .toEqual([principle.conceptId]);

    const after = await call("stage_lookup", { stage: "helm delete" });
    expect((after.json.rules as Array<Record<string, unknown>>)[0]).toMatchObject({
      conceptId: projected.conceptId, projectedFromPrincipleId: principle.conceptId, parentDisputed: true,
      disputedParentIds: [principle.conceptId],
    });

    // THE FULL ADVERTISED RECOVERY LOOP, END TO END (PR #112 round 3): the flag names the parent,
    // fetching the parent shows the dispute AND the contradiction id, and mediating that id clears
    // the flag. Every hop is an MCP call — no engine-only read anywhere on the path.
    const fetched = await call("memory_fetch", { id: principle.conceptId });
    expect(fetched.json.status).toBe("disputed");
    const open = fetched.json.openContradictions as Array<{ id: string; kind: string; detail: string }>;
    expect(open).toHaveLength(1);
    expect(open[0]!.kind).toBe("impeachment");
    const mediated = await call("memory_resolve", { contradictionId: open[0]!.id, decision: "dismiss", resolvedBy: "john" });
    expect(mediated.json.status).toBe("active");
    const cleared = await call("stage_lookup", { stage: "helm delete" });
    const clearedRule = (cleared.json.rules as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(clearedRule)).not.toContain("parentDisputed");
    expect(Object.keys(clearedRule)).not.toContain("disputedParentIds");
    // And a clean concept's fetch carries neither key — the common case pays nothing.
    const clean = await call("memory_fetch", { id: principle.conceptId });
    expect(Object.keys(clean.json)).not.toContain("status");
    expect(Object.keys(clean.json)).not.toContain("openContradictions");
    await client.close();
    c.close();
  });

  it("caps fetched open contradictions and discloses the omitted count (PR #112 round 4)", async () => {
    const c = core();
    const { call, client } = await harness(c, { modelTag: "m1" });
    const principle = await c.declare({ species: "principle", content: "Irreversible acts get a confirmation." });
    if (principle.species !== "principle") throw new Error("unreachable");
    // One impeachment per corrected child is the accumulation shape the cap exists for; direct
    // flags with distinct details reproduce it without seven corrected rules of fixture.
    for (let i = 0; i < 7; i++) {
      c.flagContradiction(principle.conceptId, { kind: "impeachment", detail: `impeachment evidence #${i}` });
    }
    const fetched = await call("memory_fetch", { id: principle.conceptId });
    expect(fetched.json.status).toBe("disputed");
    expect(fetched.json.openContradictions as unknown[]).toHaveLength(5);
    expect(fetched.json.openContradictionsOmitted).toBe(2);
    // Recovery teaching lives in the tool description; the fetch payload carries only doubt state.
    expect(fetched.json).not.toHaveProperty("contradictionsNote");

    // TIE-BREAK (PR #112 round 8, P3): with every row landing in the same millisecond — rapid
    // corrections or sync — the page must still be one deterministic subset on every replica.
    raw(c).prepare(`UPDATE contradictions SET detected_at = 1234567890 WHERE concept_id = ?`).run(principle.conceptId);
    const allIds = (raw(c).prepare(
      `SELECT id FROM contradictions WHERE concept_id = ? AND status = 'open'`,
    ).all(principle.conceptId) as Array<{ id: string }>).map((r) => r.id);
    const tied = await call("memory_fetch", { id: principle.conceptId });
    expect((tied.json.openContradictions as Array<{ id: string }>).map((k) => k.id))
      .toEqual([...allIds].sort().reverse().slice(0, 5));
    await client.close();
    c.close();
  });

  it("reports a correction that superseded a rule, so the agent learns which rule now governs", async () => {
    const c = core();
    const { call, client } = await harness(c, { modelTag: "m1" });
    const stored = await call("memory_store", {
      content: "Never force-push to a shared branch.",
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main" },
    });
    const corrected = await call("memory_store", {
      content: "Force-push is fine on your own branch; never on a shared one.",
      kind: "correction", attachTo: stored.json.conceptId as string,
    });
    expect(corrected.json.ruleSuccession).toMatchObject({
      supersededRuleId: stored.json.conceptId,
      successorRuleId: corrected.json.conceptId,
    });
    await client.close();
    c.close();
  });

  it("hands back the missing-reason refusal as a tool error, not a raw throw", async () => {
    const c = core();
    const { call, client } = await harness(c, { modelTag: "host-supplied-model" });
    // The agent has to be able to ACT on this, and the action is to go ask the user what the deny
    // prevents. An isError response puts the sentence in the transcript where that can happen; a
    // raw throw surfaces as a protocol failure, which reads as "the tool is broken" rather than
    // "you left out the one field this rule is required to carry".
    const r = await call("memory_declare", {
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a directory tree unattended.", severity: "blocking",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/blocking rule requires `reason`/);
    // And the refusal was total: no stage was addressed, so nothing fires.
    expect(c.gate({ actionContext: "Bash:rm -rf /tmp/x" }).rules).toEqual([]);
    await client.close();
    c.close();
  });

  it("refuses an agent-scoped capture when no model tag is available anywhere", async () => {
    const c = core();
    // No host modelTag and (in this process) no MONET_MODEL_TAG: an untagged compensation is
    // indistinguishable from a domain rule at the moment it matters, so it is refused.
    const priorEnv = process.env.MONET_MODEL_TAG;
    delete process.env.MONET_MODEL_TAG;
    try {
      const { call, client } = await harness(c);
      const r = await call("memory_store", { content: "A compensation.", kind: "rule", rule: { stage: "s" } });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/requires rule\.modelTag/);
      await client.close();
    } finally {
      if (priorEnv !== undefined) process.env.MONET_MODEL_TAG = priorEnv;
    }
    c.close();
  });

  it("a BLANK MONET_MODEL_TAG does NOT overwrite a valid constructor-supplied runtimeModelTag — blank counts as absent, not as a configured empty tag (Codex round 4, item 4 — THE BUG)", async () => {
    const priorEnv = process.env.MONET_MODEL_TAG;
    // Env templating produces exactly this shape routinely (MONET_MODEL_TAG=${SOME_VAR} with
    // SOME_VAR unset expands to "", never to an absent variable) — a common deployment shape, not
    // a misconfiguration this store should have to survive by luck.
    process.env.MONET_MODEL_TAG = "";
    try {
      const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, runtimeModelTag: "model-a" });
      const { call, client } = await harness(c);
      // The constructor's tag survives registration — NOT overwritten by the blank env var.
      expect(c.getRuntimeModelTag()).toBe("model-a");

      // DELIVERY still filters by the constructor's tag, not by "" (which would match nothing —
      // every compensation invisible, the exact failure this fix closes).
      const forA = await c.store("A compensation for model-a.", {
        kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force", scope: "agent", modelTag: "model-a" },
      });
      const forOther = await c.store("A compensation for a different model.", {
        kind: "rule", resolution: "forceNew", rule: { stage: "git force push", scope: "agent", modelTag: "other-model" },
      });
      expect(forA.conceptId).not.toBe(forOther.conceptId); // sanity: the excluded rule really exists
      expect(c.gate({ actionContext: "Bash:git push --force" }).rules.map((r) => r.conceptId)).toEqual([forA.conceptId]);
      expect(c.stageLookup({ stage: "git force push" }).rules.map((r) => r.conceptId)).toEqual([forA.conceptId]);

      // CAPTURE is not poisoned either: an agent-scoped write with no explicit modelTag stamps the
      // constructor's live tag, not "" — the second half of the bug this fix closes.
      const captured = await call("memory_store", {
        content: "Another compensation.", kind: "rule", rule: { stage: "rm -rf", instance: "Bash:rm -rf" },
      });
      expect(captured.isError).toBe(false);
      expect(c.ruleBinding(captured.json.conceptId as string)!.model_tag).toBe("model-a");

      await client.close();
      c.close();
    } finally {
      if (priorEnv !== undefined) process.env.MONET_MODEL_TAG = priorEnv; else delete process.env.MONET_MODEL_TAG;
    }
  });

  it("a BLANK MONET_MODEL_TAG with NO constructor tag behaves exactly like the var being absent — unconfigured unset semantics, not a poisoned empty-string filter (Codex round 4, item 4)", async () => {
    const priorEnv = process.env.MONET_MODEL_TAG;
    process.env.MONET_MODEL_TAG = "";
    try {
      const c = core(); // no constructor runtimeModelTag
      const { call, client } = await harness(c); // no opts.modelTag either
      expect(c.getRuntimeModelTag()).toBeUndefined();

      // DELIVERY: every agent-scoped rule still fires, unfiltered — the documented meaning of an
      // absent runtime tag, not "matches nothing" (which a poisoned "" would have produced).
      const stored = await c.store("A compensation.", {
        kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force", scope: "agent", modelTag: "some-model" },
      });
      expect(c.gate({ actionContext: "Bash:git push --force" }).rules.map((r) => r.conceptId)).toEqual([stored.conceptId]);
      expect(c.stageLookup({ stage: "git force push" }).rules.map((r) => r.conceptId)).toEqual([stored.conceptId]);

      // CAPTURE: unconfigured behavior — identical to no MONET_MODEL_TAG at all (see "falls back to
      // the agent's tag only when the host supplies none" above): falls back to the agent's own tag.
      const captured = await call("memory_store", {
        content: "Another compensation.", kind: "rule",
        rule: { stage: "rm -rf", instance: "Bash:rm -rf", modelTag: "agent-claimed-model" },
      });
      expect(captured.isError).toBe(false);
      expect(c.ruleBinding(captured.json.conceptId as string)!.model_tag).toBe("agent-claimed-model");

      await client.close();
      c.close();
    } finally {
      if (priorEnv !== undefined) process.env.MONET_MODEL_TAG = priorEnv; else delete process.env.MONET_MODEL_TAG;
    }
  });

  it("a WHITESPACE-ONLY MONET_MODEL_TAG behaves the same as an empty string — also does not overwrite a constructor tag", async () => {
    const priorEnv = process.env.MONET_MODEL_TAG;
    process.env.MONET_MODEL_TAG = "   ";
    try {
      const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, runtimeModelTag: "model-a" });
      const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
      registerMonetCoreTools(server, c, { autoPrewarm: false, checkpointNudge: false });
      expect(c.getRuntimeModelTag()).toBe("model-a");
      c.close();
    } finally {
      if (priorEnv !== undefined) process.env.MONET_MODEL_TAG = priorEnv; else delete process.env.MONET_MODEL_TAG;
    }
  });

  it("REFUSES an over-max modelTag at both MCP capture zod schemas — memory_store's rule.modelTag and memory_declare's modelTag (Codex round 4, item 2)", async () => {
    const c = core();
    const { call, client } = await harness(c);
    const overLong = "m".repeat(MODEL_TAG_MAX_CHARS + 1);
    const stored = await call("memory_store", {
      content: "A compensation.", kind: "rule", rule: { stage: "s", modelTag: overLong },
    });
    expect(stored.isError).toBe(true);
    const declared = await call("memory_declare", {
      species: "rule", stage: "s2", content: "Text.", modelTag: overLong,
    });
    expect(declared.isError).toBe(true);
    await client.close();
    c.close();
  });

  it("stage_lookup: hit, stage-hit-no-rules, and a miss carrying the live index, over MCP", async () => {
    const c = core();
    const { call, client } = await harness(c, { modelTag: "host-model" });

    // HIT, with a rule delivered.
    const stored = await call("memory_store", {
      content: "Watch CI after every push.",
      kind: "rule",
      rule: { stage: "opening a PR", reason: "CI failures caught late cost a re-review" },
    });
    expect(stored.isError).toBe(false);
    const hit = await call("stage_lookup", { stage: "  Opening A PR  " }); // whitespace/case, no fuzzy needed
    expect(hit.isError).toBe(false);
    expect(hit.json).toMatchObject({ matched: true, stage: { name: "opening a pr" } });
    const hitRules = hit.json.rules as Array<Record<string, unknown>>;
    expect(hitRules).toHaveLength(1);
    expect(hitRules[0]).toMatchObject({
      conceptId: stored.json.conceptId, reason: "CI failures caught late cost a re-review", severity: "advisory", scope: "agent",
    });
    expect(hit.json.stageIndex).toBeUndefined(); // only a miss carries the index

    // STAGE-HIT-NO-RULES: a registered stage with nothing bound.
    const declaredStage = await call("memory_declare", { species: "stage", stage: "an empty gate" });
    expect(declaredStage.isError).toBe(false);
    const emptyHit = await call("stage_lookup", { stage: "an empty gate" });
    expect(emptyHit.isError).toBe(false);
    expect(emptyHit.json).toMatchObject({ matched: true, rules: [] });

    // MISS: carries the live index. The empty gate has no live rule, so it stays absent from it.
    const miss = await call("stage_lookup", { stage: "no such stage anywhere" });
    expect(miss.isError).toBe(false);
    expect(miss.json.matched).toBe(false);
    expect(miss.json.stageIndex).toEqual(["opening a pr"]);

    await client.close();
    c.close();
  });

  it("stage_lookup wire response stays parseable JSON at adversarial rule/body/reason sizes (blocker fix)", async () => {
    const c = core();
    const { call, client } = await harness(c, { modelTag: "host-model" });
    await call("memory_declare", { species: "stage", stage: "adversarial stage" });
    // 20 rules, each with an 8,000-char body and a 4,000-char reason — bigger than the reviewer's
    // own probe shape (6 rules x 8,000-char bodies), so the fit loop (not luck) is what has to keep
    // this parseable.
    for (let i = 0; i < 20; i++) {
      const stored = await call("memory_store", {
        content: `Adversarial rule ${i}.`,
        kind: "rule",
        rule: { stage: "adversarial stage", reason: "r".repeat(4000) },
      });
      expect(stored.isError).toBe(false);
      raw(c).prepare(`UPDATE concepts SET body = ? WHERE id = ?`).run("b".repeat(8000), stored.json.conceptId as string);
    }
    const r = await call("stage_lookup", { stage: "adversarial stage" });
    expect(r.isError).toBe(false);
    // THE PROOF: parses cleanly and does not throw. Before this fix, ok()'s hard-slice at
    // RESULT_MAX_CHARS would land mid-object here and JSON.parse would throw a SyntaxError while
    // isError stayed false.
    const parsed = JSON.parse(r.text) as Record<string, unknown>;
    expect(parsed.matched).toBe(true);
    const rules = parsed.rules as unknown[];
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.length).toBeLessThan(20); // the fit loop actually bit — not all 20 huge rules fit
    expect(parsed.rulesTruncated).toBe(true);
    expect(parsed.rulesOmitted).toBe(20 - rules.length);
    await client.close();
    c.close();
  });

  it("stage_lookup wire carries reasonMissing — a whitespace-only reason on a blocking rule reads as true even though `reason` itself is non-null (review fix)", async () => {
    const c = core();
    const { call, client } = await harness(c, { modelTag: "host-model" });
    const declared = await call("memory_declare", {
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a directory tree unattended.", severity: "blocking", reason: "there is no undo",
    });
    expect(declared.isError).toBe(false);
    // Relay-shaped corruption: a whitespace-only reason, the exact class `hasNoReason` exists to
    // catch (gates.ts's own cross-surface-disagreement comment). Local creation refuses this, so
    // simulate what a foreign/older peer's row would look like.
    raw(c).prepare(`UPDATE rule_bindings SET reason = ? WHERE concept_id = ?`).run("\t\n ", declared.json.conceptId);

    const lookup = await call("stage_lookup", { stage: "rm -rf" });
    expect(lookup.isError).toBe(false);
    const rule = (lookup.json.rules as Array<Record<string, unknown>>)[0]!;
    expect(rule.reason).toBe("\t\n "); // non-null — the derivability trap
    expect(rule.reasonMissing).toBe(true); // ...but reasonMissing says so anyway
    await client.close();
    c.close();
  });

  it("stage_lookup resolves the SAME model tag gate() does — the HOST tag wins, filtering a genuinely foreign-tagged rule (review fix: one resolution chain)", async () => {
    const c = core();
    const { call, client } = await harness(c, { modelTag: "host-model" });

    const forHost = await call("memory_store", {
      content: "A compensation for THIS model.",
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force", modelTag: "host-model" },
    });
    expect(forHost.isError).toBe(false);
    const forOther = await call("memory_store", {
      content: "A compensation for a DIFFERENT model.",
      kind: "rule", rule: { stage: "git force push", modelTag: "some-other-model" },
    });
    expect(forOther.isError).toBe(false);
    // memory_store's own "HOST tag wins" rule stamped this with "host-model" at capture too — force
    // it back to a genuinely foreign tag (simulating a rule captured under a PRIOR model's session),
    // so there really is something for stage_lookup's OWN resolution to filter.
    raw(c).prepare(`UPDATE rule_bindings SET model_tag = ? WHERE concept_id = ?`).run("some-other-model", forOther.json.conceptId as string);

    // NO explicit tag anywhere on this call — stage_lookup's tool schema has no such argument, so
    // this exercises the RESOLUTION CHAIN itself (core.setRuntimeModelTag, wired once at
    // registration), not a pre-resolved tag stepped over by an explicit argument.
    const lookup = await call("stage_lookup", { stage: "git force push" });
    expect(lookup.isError).toBe(false);
    const ids = (lookup.json.rules as Array<{ conceptId: string }>).map((r) => r.conceptId);
    expect(ids).toContain(forHost.json.conceptId);
    expect(ids).not.toContain(forOther.json.conceptId);

    await client.close();
    c.close();
  });

  it("stage_lookup falls back to the agent's tag only when the host supplies none — same resolution memory_store uses (review fix)", async () => {
    const c = core();
    const priorEnv = process.env.MONET_MODEL_TAG;
    delete process.env.MONET_MODEL_TAG;
    try {
      const { call, client } = await harness(c); // no host modelTag anywhere
      const stored = await call("memory_store", {
        content: "A compensation.", kind: "rule",
        rule: { stage: "git force push", modelTag: "agent-claimed-model" },
      });
      expect(stored.isError).toBe(false);
      expect(c.ruleBinding(stored.json.conceptId as string)!.model_tag).toBe("agent-claimed-model");

      // No host tag anywhere means core.setRuntimeModelTag was never called (registerMonetCoreTools
      // only calls it when defaultModelTag is defined), so this must resolve exactly like an
      // untagged runtime: every agent-scoped rule still fires, unfiltered.
      const lookup = await call("stage_lookup", { stage: "git force push" });
      expect(lookup.isError).toBe(false);
      expect((lookup.json.rules as Array<{ conceptId: string }>).map((r) => r.conceptId))
        .toContain(stored.json.conceptId);
      await client.close();
    } finally {
      if (priorEnv !== undefined) process.env.MONET_MODEL_TAG = priorEnv;
    }
    c.close();
  });

  it("stage input has a sane max length — a multi-MB name is rejected at the schema boundary (item 8c)", async () => {
    const c = core();
    const { call, client } = await harness(c);
    const r = await call("stage_lookup", { stage: "x".repeat(10_000) });
    expect(r.isError).toBe(true);
    await client.close();
    c.close();
  });

  it("stage_lookup MISS: stageIndex stays parseable JSON with hundreds of long stage names (Codex round 1, item 1)", async () => {
    const c = core();
    const { call, client } = await harness(c);
    // 300 stages, each named close to STAGE_NAME_MAX_CHARS (491 of 500), each with one live
    // domain rule so it enters liveStageIndex. Codex's own finding: stage creation imposes no
    // aggregate/name-size bound, so a miss's stageIndex could serialize unbounded — the exact
    // "ok() hard-slices mid-JSON with isError:false" class the rules/body blocker was fixed for.
    for (let i = 0; i < 300; i++) {
      const name = `stage-${String(i).padStart(4, "0")}-${"x".repeat(480)}`;
      const stored = await call("memory_store", {
        content: `Rule for stage ${i}.`,
        kind: "rule",
        rule: { stage: name, scope: "domain" },
      });
      expect(stored.isError).toBe(false);
    }
    const r = await call("stage_lookup", { stage: "no such stage at all" });
    expect(r.isError).toBe(false);
    // THE PROOF: parses cleanly. Before this fix, 300 names at ~500 chars each (~150,000 chars)
    // would have been serialized whole, then hard-sliced by ok() at RESULT_MAX_CHARS.
    const parsed = JSON.parse(r.text) as Record<string, unknown>;
    expect(parsed.matched).toBe(false);
    const index = parsed.stageIndex as string[];
    expect(Array.isArray(index)).toBe(true);
    expect(index.length).toBeGreaterThan(0);
    expect(index.length).toBeLessThan(300); // the fit loop actually bit — not all 300 fit
    expect(parsed.stageIndexTruncated).toBe(true);
    expect(parsed.stageIndexOmitted).toBe(300 - index.length);
    await client.close();
    c.close();
  }, 30_000);

  it("a stage created at EXACTLY STAGE_NAME_MAX_CHARS is lookupable by its advertised name — the shared constant (Codex round 1, item 2)", async () => {
    const c = core();
    const maxName = "s".repeat(STAGE_NAME_MAX_CHARS);
    const stored = await c.store("A rule at the exact name-length boundary.", {
      kind: "rule", rule: { stage: maxName, scope: "domain" },
    });
    const r = c.stageLookup({ stage: maxName });
    expect(r.matched).toBe(true);
    expect(r.rules.map((rule) => rule.conceptId)).toEqual([stored.conceptId]);
    c.close();
  });

  it("refuses to CREATE a stage whose name exceeds STAGE_NAME_MAX_CHARS — a named refusal, not a silent truncation (Codex round 1, item 2, enforce branch)", async () => {
    const c = core();
    const overLong = "s".repeat(STAGE_NAME_MAX_CHARS + 1);
    await expect(
      c.store("A rule with an over-long stage name.", { kind: "rule", rule: { stage: overLong, scope: "domain" } }),
    ).rejects.toThrow(new RegExp(`at most ${STAGE_NAME_MAX_CHARS} characters`));
    // The refusal was total: no stage, no rule, nothing left half-created.
    expect(c.stageLookup({ stage: overLong }).matched).toBe(false);
    c.close();
  });

  it("memory_store/memory_declare reject an over-long stage name at the MCP schema boundary too — same shared constant (Codex round 1, item 2)", async () => {
    const c = core();
    const { call, client } = await harness(c);
    const overLong = "s".repeat(STAGE_NAME_MAX_CHARS + 1);
    const stored = await call("memory_store", {
      content: "A rule with an over-long stage name.", kind: "rule", rule: { stage: overLong, scope: "domain" },
    });
    expect(stored.isError).toBe(true);
    const declared = await call("memory_declare", { species: "stage", stage: overLong });
    expect(declared.isError).toBe(true);
    await client.close();
    c.close();
  });

  it("omitted rules get a compact outline (conceptId + text) — a real recovery path, not just a count (Codex round 1, item 3)", async () => {
    const c = core();
    const { call, client } = await harness(c, { modelTag: "host-model" });
    await call("memory_declare", { species: "stage", stage: "adversarial stage 2" });
    const storedIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const stored = await call("memory_store", {
        content: `Adversarial rule ${i}.`,
        kind: "rule",
        rule: { stage: "adversarial stage 2", reason: "r".repeat(4000) },
      });
      expect(stored.isError).toBe(false);
      storedIds.push(stored.json.conceptId as string);
      raw(c).prepare(`UPDATE concepts SET body = ? WHERE id = ?`).run("b".repeat(8000), stored.json.conceptId as string);
    }
    const r = await call("stage_lookup", { stage: "adversarial stage 2" });
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.text) as Record<string, unknown>; // parseable at adversarial size
    expect(parsed.rulesTruncated).toBe(true);
    const fittedIds = (parsed.rules as Array<{ conceptId: string }>).map((rule) => rule.conceptId);
    expect(["outline", "outline-partial"]).toContain(parsed.omittedRulesDetail);
    const omittedRules = parsed.omittedRules as Array<{ conceptId: string; text: string }>;
    expect(omittedRules.length).toBeGreaterThan(0);
    // Every outline entry names a rule that really was omitted (not double-counted with the ones
    // already shown) and is a real, memory_fetch-able id from this store — correct ids, not filler.
    for (const entry of omittedRules) {
      expect(fittedIds).not.toContain(entry.conceptId);
      expect(storedIds).toContain(entry.conceptId);
      expect(typeof entry.text).toBe("string");
      expect(entry.text.length).toBeGreaterThan(0);
    }
    await client.close();
    c.close();
  });

  it("the degradation ladder actually degrades under heavier load — outline-partial, not a silent full outline (Codex round 1, item 3)", async () => {
    const c = core();
    const { call, client } = await harness(c, { modelTag: "host-model" });
    await call("memory_declare", { species: "stage", stage: "heavy adversarial stage" });
    // 100 rules, max-length (80-char) titles and 8,000-char bodies — empirically measured (probe,
    // not guessed) to fit 5 in `rules`, leave 95 omitted, and let the outline itself name only 18
    // of those 95 before ITS OWN size-fit stops: omittedRulesDetail = "outline-partial", and the
    // whole response still lands at 39,858 chars — under the 40,000 ceiling, never over it.
    for (let i = 0; i < 100; i++) {
      const stored = await call("memory_store", {
        content: "A".repeat(200), // -> an 80-char, max-length title after firstLine's truncation
        kind: "rule",
        rule: { stage: "heavy adversarial stage", reason: "r".repeat(1000) },
      });
      expect(stored.isError).toBe(false);
      raw(c).prepare(`UPDATE concepts SET body = ? WHERE id = ?`).run("b".repeat(8000), stored.json.conceptId as string);
    }
    const r = await call("stage_lookup", { stage: "heavy adversarial stage" });
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.text) as Record<string, unknown>; // parseable at adversarial size
    expect(r.text.length).toBeLessThanOrEqual(40_000);
    expect(parsed.rulesTruncated).toBe(true);
    expect(parsed.rulesOmitted).toBeGreaterThan(50);
    // THE DEGRADATION LADDER ACTUALLY FIRING: the outline itself could not name every omitted
    // rule, and says so, rather than silently returning a partial list under the "outline" label.
    expect(parsed.omittedRulesDetail).toBe("outline-partial");
    const omittedRules = parsed.omittedRules as Array<{ conceptId: string; text: string }>;
    expect(omittedRules.length).toBeGreaterThan(0);
    expect(omittedRules.length).toBeLessThan(parsed.rulesOmitted as number);
    await client.close();
    c.close();
  }, 30_000);

  it("agent_context's own stageIndex stays parseable JSON and truncates with a signal at the same adversarial scale (Codex round 1, item 1: named this surface too)", async () => {
    const c = core();
    const { call, client } = await harness(c);
    for (let i = 0; i < 300; i++) {
      const name = `stage-${String(i).padStart(4, "0")}-${"x".repeat(480)}`;
      const stored = await call("memory_store", {
        content: `Rule for stage ${i}.`,
        kind: "rule",
        rule: { stage: name, scope: "domain" },
      });
      expect(stored.isError).toBe(false);
    }
    const ctx = await call("agent_context", {});
    expect(ctx.isError).toBe(false);
    const parsed = JSON.parse(ctx.text) as Record<string, unknown>; // parses cleanly at adversarial scale
    const index = parsed.stageIndex as string[];
    expect(Array.isArray(index)).toBe(true);
    expect(index.length).toBeGreaterThan(0);
    expect(index.length).toBeLessThan(300);
    expect(parsed.stageIndexTruncated).toBe(true);
    expect(parsed.stageIndexOmitted).toBe(300 - index.length);
    await client.close();
    c.close();
  }, 30_000);

  it("wire ladder stays honest when SQL-level retrieval is capped: rulesOmitted reflects the TRUE total, and whichever recovery tier lands is internally consistent (Codex round 2, item 2)", async () => {
    const c = core();
    const { call, client } = await harness(c);
    await call("memory_declare", { species: "stage", stage: "sql-capped stage" });
    // 220 rules — past STAGE_LOOKUP_RULES_CAP (200), triggering the SQL-level cap. Domain-scoped
    // (no modelTag) to keep per-rule size as small as this surface's fields allow; EMPIRICALLY
    // measured (probe, not guessed) that even this shape lands the wire's OWN size-fit around
    // ~145 rules shown, well before the SQL cap of 200 — meaning the SQL cap bounds RETRIEVAL cost,
    // not "how many the wire happens to show", and the exact degradation tier that results is
    // sensitive to per-rule JSON overhead this test deliberately does not hardcode.
    const RULE_COUNT = 220;
    for (let i = 0; i < RULE_COUNT; i++) {
      const stored = await call("memory_store", {
        content: `Rule number ${i}.`, kind: "rule", rule: { stage: "sql-capped stage", scope: "domain" },
      });
      expect(stored.isError).toBe(false);
    }
    const r = await call("stage_lookup", { stage: "sql-capped stage" });
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.text) as Record<string, unknown>; // parses cleanly at this scale
    const shownCount = (parsed.rules as unknown[]).length;
    expect(shownCount).toBeLessThanOrEqual(200); // the SQL-level cap, never exceeded
    expect(parsed.rulesTruncated).toBe(true);
    // THE HONEST NUMBER: the TRUE total (220, via the engine's rulesTotal) minus what was actually
    // shown — proving the wire did NOT fall back to "200 (the SQL-capped fetch size) minus shown",
    // which would understate what is truly omitted whenever the wire's own size-fit ALSO binds
    // (which it does here — see the comment above).
    expect(parsed.rulesOmitted).toBe(RULE_COUNT - shownCount);
    // WHICHEVER degradation tier landed, its OWN fields must be internally consistent — this does
    // not hardcode one tier, because the byte math that decides it is sensitive to per-rule JSON
    // overhead (see the round-1 degradation test for how differently two "similar" adversarial
    // shapes can land).
    const detail = parsed.omittedRulesDetail as string;
    expect(["outline", "outline-partial", "ids", "ids-partial", "count-only"]).toContain(detail);
    if (detail.startsWith("outline")) {
      const omittedRules = parsed.omittedRules as Array<{ conceptId: string; text: string }>;
      expect(omittedRules.length).toBeGreaterThan(0);
      for (const entry of omittedRules) expect(typeof entry.conceptId).toBe("string");
      expect(parsed.omittedRuleIds).toBeUndefined();
    } else if (detail.startsWith("ids")) {
      const omittedRuleIds = parsed.omittedRuleIds as string[];
      expect(omittedRuleIds.length).toBeGreaterThan(0);
      expect(parsed.omittedRules).toBeUndefined();
    } else {
      expect(parsed.omittedRules).toBeUndefined();
      expect(parsed.omittedRuleIds).toBeUndefined();
    }
    await client.close();
    c.close();
  }, 30_000);

  it("unconfigured deployment: a foreign-model agent-scoped rule is delivered WITH modelTag/origin visible — non-derivability fix (Codex round 2, item 3)", async () => {
    const c = core();
    const priorEnv = process.env.MONET_MODEL_TAG;
    delete process.env.MONET_MODEL_TAG;
    try {
      // UNCONFIGURED: no host modelTag, no MONET_MODEL_TAG. VERIFIED PREMISE (see gates.ts's
      // RULE_LIVENESS_WHERE: `b.scope != 'agent' OR ? IS NULL OR b.model_tag = ?`) — a NULL
      // runtime tag makes `? IS NULL` true unconditionally, so every agent-scoped rule fires
      // REGARDLESS of its own model_tag. scope:"agent" therefore does NOT mean "for this model"
      // here, and without modelTag on the wire an agent has no way to notice a stale compensation.
      const { call, client } = await harness(c);
      const stored = await call("memory_store", {
        content: "A compensation for a specific model.",
        kind: "rule", rule: { stage: "git force push", modelTag: "some-model" },
      });
      expect(stored.isError).toBe(false);
      // Force it to look like a compensation for a model that is clearly not "whatever is running"
      // (there is no runtime tag at all here, which is the whole point being tested).
      raw(c).prepare(`UPDATE rule_bindings SET model_tag = ? WHERE concept_id = ?`).run("foreign-model", stored.json.conceptId as string);

      const lookup = await call("stage_lookup", { stage: "git force push" });
      expect(lookup.isError).toBe(false);
      const rule = (lookup.json.rules as Array<Record<string, unknown>>)[0]!;
      expect(rule.conceptId).toBe(stored.json.conceptId); // DELIVERED (confirms the premise)
      expect(rule.modelTag).toBe("foreign-model"); // ...and now VISIBLE, so it can be noticed
      expect(["correction", "declaration", "projection", "import"]).toContain(rule.origin);
      await client.close();
    } finally {
      if (priorEnv !== undefined) process.env.MONET_MODEL_TAG = priorEnv;
    }
    c.close();
  });

  it("configured deployment unchanged: modelTag/origin still delivered for a rule matching the resolved runtime tag", async () => {
    const c = core();
    const { call, client } = await harness(c, { modelTag: "host-model" });
    const stored = await call("memory_store", {
      content: "A compensation for THIS model.",
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force", modelTag: "host-model" },
    });
    expect(stored.isError).toBe(false);
    const lookup = await call("stage_lookup", { stage: "git force push" });
    expect(lookup.isError).toBe(false);
    const rule = (lookup.json.rules as Array<Record<string, unknown>>)[0]!;
    expect(rule.conceptId).toBe(stored.json.conceptId);
    expect(rule.modelTag).toBe("host-model");
    expect(["correction", "declaration", "projection", "import"]).toContain(rule.origin);
    await client.close();
    c.close();
  });

  it("domain-scoped rules omit modelTag on the wire — the existing null-vs-omit convention, origin still always present", async () => {
    const c = core();
    const { call, client } = await harness(c);
    const stored = await call("memory_store", {
      content: "A domain rule.", kind: "rule", rule: { stage: "domain stage", scope: "domain" },
    });
    expect(stored.isError).toBe(false);
    const lookup = await call("stage_lookup", { stage: "domain stage" });
    expect(lookup.isError).toBe(false);
    const rule = (lookup.json.rules as Array<Record<string, unknown>>)[0]!;
    expect(rule.conceptId).toBe(stored.json.conceptId);
    expect(rule).not.toHaveProperty("modelTag");
    expect(["correction", "declaration", "projection", "import"]).toContain(rule.origin);
    await client.close();
    c.close();
  });
});

// ---------------------------------------------------------------------------
// the performance contract
// ---------------------------------------------------------------------------
describe("gate performance", () => {
  /**
   * WHY THIS TEST IS CALIBRATED AND RATIO-BASED RATHER THAN ABSOLUTE.
   *
   * An earlier version asserted a bare `p95 < 1ms` and failed CI at p50=1.069/p95=1.159 — on a
   * runner that is simply slower hardware, uniformly, for every operation. Best-of-batches removes
   * scheduler NOISE but cannot remove a slower CPU, so an absolute millisecond bound in a portable
   * test measures the machine and calls it a regression.
   *
   * The product contract is still sub-millisecond on reference hardware, and it is stated where it
   * belongs — in the module docs, against named numbers. What a PORTABLE test can prove is what
   * actually rots when this code regresses:
   *
   *   1. SCALING, asserted unconditionally and hardware-independently. A slower machine scales both
   *      sides of a ratio, so the ratios hold everywhere. These are the assertions that catch the
   *      real failure mode — an O(stages x context) matcher — with orders of magnitude of margin.
   *   2. AN ABSOLUTE BOUND CALIBRATED IN-PROCESS: a baseline primitive measured on the same machine
   *      in the same run, with the gate held to a generous multiple of it, plus a hard ceiling that
   *      only fires on catastrophe.
   */

  /**
   * The calibration primitive: prepared-statement round trips and short string scans, which is
   * what a gate lookup is made of. Deliberately NOT a gate call — it has to move with the hardware
   * without moving with the code under test.
   */
  function baselineOnce(db: RawDb): void {
    const q = db.prepare("SELECT 1 AS one");
    let acc = 0;
    for (let i = 0; i < 200; i++) {
      q.get();
      const text = `Bash:tool${i} run --flag${i} operand`;
      for (let ch = 0; ch < text.length; ch++) acc += text.charCodeAt(ch);
    }
    if (acc < 0) throw new Error("unreachable");
  }

  /** Best-of-batches p95 — batches absorb the runner's scheduler, the minimum picks a clean one. */
  function bestP95(fn: () => void, iters: number, batches = 8): number {
    for (let i = 0; i < Math.min(100, iters); i++) fn();
    const out: number[] = [];
    for (let b = 0; b < batches; b++) {
      const samples: number[] = [];
      for (let i = 0; i < iters; i++) {
        const started = process.hrtime.bigint();
        fn();
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
      samples.sort((a, b2) => a - b2);
      out.push(samples[Math.floor(samples.length * 0.95)]!);
    }
    return Math.min(...out);
  }

  it("does not scale with stage count times context length — the matcher stays indexed", () => {
    // THE ALGORITHMIC GUARD, and the one that needs no hardware assumptions at all. It exercises the
    // pure matcher, so there is no DB, no clock and no I/O in the measurement.
    //
    // Before the context index, matching N patterns against a long context rescanned the whole token
    // stream once per pattern: 200 stages x 4,000 tokens = 800k comparisons, measured at 2.4ms and
    // the reason a context cap looked necessary. Indexed, a pattern whose first token is absent
    // costs one Map lookup, so a 400x longer context costs essentially the same. The bound below is
    // 20x — two orders of magnitude of headroom against the linear behaviour, which no hardware
    // difference can manufacture.
    const patterns = Array.from({ length: 200 }, (_, i) => seedTriggerPattern(`Bash:tool${i} run --flag${i}`));
    const short = parseActionContext("Bash:tool7 run --flag7 operand");
    const long = parseActionContext(
      `Bash:${Array.from({ length: 4000 }, (_, i) => `arg${i}`).join(" ")} && tool42 run --flag42`,
    );
    const matchAll = (ctx: ReturnType<typeof parseActionContext>) => (): void => {
      for (const pattern of patterns) matchesTriggerPattern(pattern, ctx);
    };
    const shortCost = bestP95(matchAll(short), 150, 5);
    const longCost = bestP95(matchAll(long), 150, 5);
    expect(longCost, `match 200 patterns: short=${shortCost.toFixed(5)}ms long=${longCost.toFixed(5)}ms`)
      .toBeLessThan(Math.max(shortCost * 20, 0.05));
  });

  /**
   * ONE fixture for the whole block, built ONCE.
   *
   * This is a CI-COURTESY measure as much as a speed one, and the lesson cost a red build: vitest
   * runs test FILES in parallel workers, so a benchmark that pins a core for twelve seconds does
   * not merely measure a two-core runner — it STARVES the other workers, and an unrelated file
   * (gather.test.ts, on vitest's default 5s timeout) failed with a worker RPC timeout while this
   * one was busy. A perf test that makes its neighbours fail is a worse test than no perf test.
   *
   * Three changes bought back ~85% of it, in order of size:
   *
   *   - `resolution: "forceNew"` and `graphEnabled: false` when BUILDING. Both the nomination scan
   *     and edge derivation compare an incoming concept against every other concept in the circle,
   *     so building the fixture through the ordinary path is quadratic and dwarfed everything being
   *     measured. The gate reads stages, rule_bindings, concepts and lifecycle_edges — never
   *     memory_edge, never an observation vector — so the shape it measures is identical.
   *   - ONE fixture for the block instead of one per test.
   *   - A fixture SCALE the test can afford. See below.
   *
   * WHY THE TEST'S SCALE IS SMALLER THAN THE CONTRACT'S. The stated contract is 200 stages / 1,000
   * rules, and gate latency really does move with the rules DELIVERED per fire (measured: 1 rule
   * 0.24ms, 2 rules 0.27ms, 5 rules 0.48ms), so a smaller fixture measures a smaller number — this
   * is not a scale-free quantity and pretending otherwise would be the dishonest version of this
   * fix. What the test is FOR, though, is regression detection, and every assertion here is a ratio
   * or a calibrated multiple that holds at any scale. The contract NUMBER is verified out of band
   * against the full 1,000-rule shape (scripts-free harness, re-run and reported every review
   * round) and stated in the gates.ts module docs against named reference hardware. A CI job is the
   * wrong place to defend a millisecond; it is the right place to defend a slope.
   */
  const PERF_STAGES = 200;
  const PERF_RULES = 400;
  let fixture: MonetCore;
  beforeAll(async () => {
    fixture = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, graphEnabled: false });
    for (let s = 0; s < PERF_STAGES; s++) {
      await fixture.declare({ species: "stage", stage: `stage-${s}`, patterns: [`Bash:tool${s} run --flag${s}`] });
    }
    for (let r = 0; r < PERF_RULES; r++) {
      await fixture.store(`Rule number ${r} for stage ${r % PERF_STAGES}.`, {
        kind: "rule", resolution: "forceNew", rule: { stage: `stage-${r % PERF_STAGES}`, ...AGENT_RULE },
      });
    }
  }, 180_000);
  afterAll(() => fixture?.close());

  it("answers within a calibrated budget at scale, and silence costs less than a fire", () => {
    const c = fixture;
    expect(c.stages()).toHaveLength(PERF_STAGES);
    expect(raw(c).prepare(`SELECT COUNT(*) AS n FROM rule_bindings`).get()).toEqual({ n: PERF_RULES });
    const db = raw(c);

    const baseline = bestP95(() => baselineOnce(db), 100, 5);
    const fire = bestP95(() => { c.gate({ actionContext: "Bash:tool7 run --flag7 with some operands", record: false }); }, 100, 5);
    const silence = bestP95(() => { c.gate({ actionContext: "Bash:git status", record: false }); }, 100, 5);
    const midChain = bestP95(() => { c.gate({ actionContext: "Bash:cd /x && tool199 run --flag199 now", record: false }); }, 100, 5);
    const report =
      `baseline=${baseline.toFixed(4)}ms fire=${fire.toFixed(4)}ms (${(fire / baseline).toFixed(1)}x) ` +
      `silence=${silence.toFixed(4)}ms midChain=${midChain.toFixed(4)}ms`;

    // RATIO: a silence does strictly less work than a fire — no binding join, no rule marshalling.
    // If that inverts, something is doing per-stage work that should be per-match.
    expect(silence, report).toBeLessThan(fire);
    // CALIBRATED ABSOLUTE. Locally the gate is ~13x the baseline primitive; 60x is generous enough
    // that no plausible hardware trips it and tight enough that an algorithmic regression (which
    // moves this by orders of magnitude, not tens of percent) still does.
    expect(fire, report).toBeLessThan(baseline * 60);
    expect(midChain, report).toBeLessThan(baseline * 60);
    // CATASTROPHE CEILING: an absolute number that says nothing about hardware and everything about
    // whether the gate is still usable on the critical path of an action.
    expect(fire, report).toBeLessThan(10);
  }, 60_000);

  it("matches a 64KiB context in full, and stays linear rather than multiplying by stage count", () => {
    const c = fixture;
    // THE POINT OF THE WHOLE ITEM: a governed command hidden behind 64KiB of padding still FIRES.
    // Under either of the two prefix-matching caps this reported silence.
    const big = `Bash:${"x".repeat(64 * 1024)} && tool42 run --flag42`;
    expect(c.gate({ actionContext: big, record: false }).rules.length).toBeGreaterThan(0);

    const fire = bestP95(() => { c.gate({ actionContext: "Bash:tool7 run --flag7 operand", record: false }); }, 80, 5);
    const bigCost = bestP95(() => { c.gate({ actionContext: big, record: false }); }, 20, 5);
    const report = `fire=${fire.toFixed(4)}ms 64KiB=${bigCost.toFixed(4)}ms (${(bigCost / fire).toFixed(1)}x)`;
    // Linear in the string's length, NOT in stages x length: locally 64KiB is ~1.5x a normal fire.
    // 40x leaves room for a slow runner's memory bandwidth while still failing loudly if the
    // per-stage rescan ever comes back (which would put this in the hundreds).
    expect(bigCost, report).toBeLessThan(Math.max(fire * 40, 0.5));
  }, 60_000);
});
