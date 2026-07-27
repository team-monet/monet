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
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MonetCore } from "../engine";
import { registerMonetCoreTools } from "../mcp-server";
import { renderOverview } from "../render-overview";
import {
  bindRule,
  COMMAND_BOUNDARY,
  createGateSchema,
  formatTriggerPattern,
  readTriggerPatterns,
  upsertStage,
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
import type { BlockingSidecar, SidecarMaterialization } from "../gates";
import { BetterSqlitePort, type Statement } from "../storage";
import { formatSpan } from "../spans";

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

  it("a rule corrected twice is two observations, one rule — and its address does not move", async () => {
    const c = resolvingCore();
    const first = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    const second = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "some other gate", instance: "Bash:rm -rf", ...AGENT_RULE },
    });

    expect(second.conceptId).toBe(first.conceptId);
    expect(second.action).toBe("attached");
    expect(second.concept.supportCount).toBe(2);
    // The rule's address did NOT move — an incidental repeat must not re-address a live rule — and
    // the stage the repeat named is NOT created either. Creating it left an unbound stage that
    // fires nothing, can never fire anything, and sits on the dead-pattern watchlist forever.
    expect(c.stages().map((s) => s.name)).toEqual(["git force push"]);
    const bound = c.stages().find((s) => s.id === c.ruleBinding(first.conceptId)!.stage_id)!;
    expect(bound.name).toBe("git force push");
    c.close();
  });

  it("creates no orphan stage when the binding it would serve is kept", async () => {
    const c = resolvingCore();
    const first = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", ...AGENT_RULE },
    });
    // A repeat naming a DIFFERENT action keeps the incumbent binding — and used to leave the newly
    // named stage behind, unbound: it fires nothing, can never fire anything, and sits on the
    // dead-pattern watchlist forever.
    await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "some other gate", instance: "Bash:rm -rf", ...AGENT_RULE },
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
  it("births the successor, records the supersession, and leaves the incumbent as history", async () => {
    const c = core();
    const rule = await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force origin main", reason: "destroys commits", ...AGENT_RULE },
    });
    c.promoteToFirstBlock(rule.conceptId, "force-push rule", "default");
    const blockBefore = c.listFirstBlock("default");

    const correction = await c.store("Force-push is fine on your own branch; never on a shared one.", {
      kind: "correction",
      attachTo: rule.conceptId,
    });

    // The correction did NOT land on the rule — it created the rule that replaces it.
    expect(correction.conceptId).not.toBe(rule.conceptId);
    expect(correction.action).toBe("created");
    expect(correction.concept.kind).toBe("rule");
    expect(correction.ruleSuccession).toMatchObject({
      supersededRuleId: rule.conceptId,
      successorRuleId: correction.conceptId,
      stageId: c.ruleBinding(rule.conceptId)!.stage_id,
    });

    // The act is on the record, as a supersession edge born of the correction that caused it.
    const edges = c.getLifecycleEdges(rule.conceptId, { direction: "out", family: "supersession" });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      src_concept_id: rule.conceptId,
      dst_concept_id: correction.conceptId,
      born_of: "correction",
      event_ref: correction.observationId,
    });

    // The successor holds the same gate, advisory-born, with the reason carried forward.
    expect(c.ruleBinding(correction.conceptId)).toMatchObject({
      stage_id: c.ruleBinding(rule.conceptId)!.stage_id,
      severity: "advisory",
      origin: "correction",
      reason: "destroys commits",
    });

    // NO contradiction opened: a superseded rule is settled history, not disputed evidence...
    expect(correction.contradiction).toBeUndefined();
    // ...and the First Block was not invalidated, because nothing attached to the pinned concept.
    // (Read before any getConcept below: fetching a dirty concept SYNTHESIZES it, which legitimately
    // invalidates its pinned summary — that would be this assertion measuring the test, not the code.)
    expect(c.listFirstBlock("default")).toEqual(blockBefore);
    expect((await c.getConcept(rule.conceptId))!.status).toBe("active");
    c.close();
  });

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

  it("rejects a species beyond rule and stage, and a rule with no content", async () => {
    const c = core();
    await expect(c.declare({ species: "principle" as unknown as "rule", stage: "x" }))
      .rejects.toThrow(/declares 'rule' and 'stage'/);
    await expect(c.declare({ species: "rule", stage: "x", ...AGENT_RULE }))
      .rejects.toThrow(/requires `content`/);
    await expect(c.declare({ species: "stage", stage: "  " })).rejects.toThrow(/requires `stage`/);
    c.close();
  });
});

// ---------------------------------------------------------------------------
// the blocking sidecar
// ---------------------------------------------------------------------------
describe("blocking sidecar — the materialized mirror", () => {
  const read = (path: string): BlockingSidecar => JSON.parse(readFileSync(path, "utf8")) as BlockingSidecar;

  it("regenerates on every declaration, atomically, leaving no temp file behind", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, syncDeviceId: "machine-a" });

    // An advisory declaration still rebuilds the mirror — and correctly writes an EMPTY one, which
    // is meaningfully different from a missing file (a hook must read that as "no mirror").
    await c.declare({ species: "rule", stage: "terraform apply", content: "Always run plan first.", ...AGENT_RULE });
    expect(read(path)).toMatchObject({ storeIdentity: "machine-a", entries: [] });

    const declared = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a directory tree unattended.",
      severity: "blocking", reason: "there is no undo", declaredBy: "john", ...AGENT_RULE,
    });
    if (declared.species !== "rule") throw new Error("unreachable");

    const sidecar = read(path);
    expect(sidecar.entries).toHaveLength(1);
    expect(sidecar.entries[0]).toMatchObject({
      stageName: "rm -rf",
      conceptId: declared.conceptId,
      ruleText: "Never delete a directory tree unattended",
      reason: "there is no undo",
      declaredBy: "john",
      circle: "default",
      patterns: [{ tool: "bash", tokens: ["rm", "-rf"] }],
      patternText: ["bash: rm -rf"],
    });
    expect(typeof sidecar.generatedAt).toBe("number");

    // Atomic: tmp+rename, so the directory holds exactly the finished file.
    expect(readdirSync(dir)).toEqual(["gate-sidecar.json"]);

    // A second deny joins it, in the gate's own deterministic order.
    await c.declare({
      species: "rule", stage: "git force push", patterns: ["Bash:git push --force"],
      content: "Never force-push to main.", severity: "blocking",
      reason: "a rewritten history cannot be recovered from a teammate's clone", ...AGENT_RULE,
    });
    expect(read(path).entries.map((e) => e.stageName)).toEqual(["git force push", "rm -rf"]);

    // The mirror follows the store — but a live deny cannot simply be retired any more (the
    // chokepoint refuses), so withdrawing it is a declaration first and ordinary cleanup after.
    expect(() => c.retireConcept(declared.conceptId)).toThrow(/would remove the blocking rule/);
    await withdrawDeny(c, declared.conceptId, "rm -rf");
    c.retireConcept(declared.conceptId);
    expect(c.materializeBlockingSidecar().sidecar.entries.map((e) => e.stageName)).toEqual(["git force push"]);
    expect(read(path).entries.map((e) => e.stageName)).toEqual(["git force push"]);
    c.close();
  });

  it("drops a deny from the mirror when a declaration downgrades it to advisory", async () => {
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

    const again = await c.declare({
      species: "rule", stage: "rm -rf", content: "Never delete a directory tree unattended.",
      severity: "advisory", ...AGENT_RULE,
    });
    if (again.species !== "rule") throw new Error("unreachable");
    expect(again.conceptId).toBe(first.conceptId);
    expect(read(path).entries).toEqual([]);
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
    // 3 since `reasonMissing` joined the entry shape. A v2 reader pointed at this file would render
    // a reasonless deny as though nothing were wrong, which is the silent-omission failure the
    // version number exists to prevent — so the shape change earns the bump even though this field,
    // unlike scope/modelTag below, does not decide whether a deny APPLIES.
    expect(sidecar.format).toBe(3);
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
    expect(() => c.materializeBlockingSidecar()).toThrow(/needs a path/);

    const rebuilt = c.materializeBlockingSidecar(path);
    // Explicit recovery against a path that held no file: this is the caller install tooling is,
    // and "written" is the answer that entitles it to say the mirror was regenerated.
    expect(rebuilt.outcome).toBe("written");
    expect(rebuilt.sidecar.entries).toHaveLength(1);
    expect(read(path).entries[0]!.ruleText).toBe("Never delete a tree unattended");
    c.close();
  });
});

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------
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
    expect(rendered).toContain("GATES");
    expect(rendered).toContain("2 asked · 1 matched a stage · 1 silent · 1 delivered a rule");
    expect(rendered).toContain("git force push");
    expect(rendered).toContain("1 pattern(s) never fired");
    expect(rendered).toContain("*: frobnicate --hard");
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
    expect(payload.schemaVersion).toBe(12);
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

    // The MIRROR says it too — the hook runs when the server is unreachable, which is already the
    // moment a user is least able to go and look the reason up.
    const entry = dst.materializeBlockingSidecar().sidecar.entries[0]!;
    expect(entry).toMatchObject({ conceptId, reason: null, reasonMissing: true });
    // Present in the FILE, not merely in the return value: the file is what the hook reads.
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as BlockingSidecar;
    expect(onDisk.format).toBe(3);
    expect(onDisk.entries[0]).toMatchObject({ reasonMissing: true });

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
      expect(dst.materializeBlockingSidecar().sidecar.entries[0]).toMatchObject({ reasonMissing: true });
      expect(dst.gateStats("default").unexplainedDenies).toMatchObject([{ conceptId, stageName: "rm -rf" }]);
      const rendered = renderOverview(dst.overview("default"), { color: false });
      expect(rendered).toContain("1 deny(s) arrived with no reason");
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
      // explanation, so the rule has none.
      expect(c.materializeBlockingSidecar().sidecar.entries[0]).toMatchObject({ reasonMissing: true });
      expect(c.gateStats("default").unexplainedDenies).toMatchObject([{ conceptId: deny.conceptId }]);
      expect(renderOverview(c.overview("default"), { color: false })).toContain("arrived with no reason");
      // Delivered as NULL, not as the raw value: `reason` is declared `string | null`, and handing a
      // caller a Buffer moves the crash from this module into theirs. The mirror stays readable JSON
      // for the same reason.
      expect(fired.rules[0]!.reason).toBeNull();
      expect(c.materializeBlockingSidecar().sidecar.entries[0]!.reason).toBeNull();
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
    expect(dst.materializeBlockingSidecar(join(mkTmp(), "s.json")).sidecar.entries).toEqual([]);
    // ...so DISCLOSURE must not say it does. Naming it here told the user to redeclare a rule whose
    // redeclaration would CREATE the missing stage and change what the store does — a repair queue
    // giving advice that alters behaviour rather than restoring it.
    expect(dst.gateStats("default").unexplainedDenies).toEqual([]);
    expect(renderOverview(dst.overview("default"), { color: false })).not.toContain("arrived with no reason");

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
    expect(renderOverview(dst.overview("default"), { color: false })).not.toContain("arrived with no reason");
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
    expect(dst.materializeBlockingSidecar().sidecar.entries[0]).toMatchObject({
      reason: "there is no undo", reasonMissing: false,
    });
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
    expect(rendered).toContain("GATES");
    expect(rendered).toContain("1 deny(s) arrived with no reason");
    // Named as a repair with the actual next action, not as an alarm: these denies are working, and
    // only a human can supply what is missing.
    expect(rendered).toContain("declare the same rule with a reason to repair");
    // THE RULE ITSELF, on the line: the stage to declare at and the text to declare. A disclosure
    // whose purpose is repair has to say what to repair, or it is an alarm wearing its clothes.
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
    // Seven, against a cap of five. The population is small BY CONSTRUCTION — local creation is
    // refused, so every one of these arrived by relay — but "small by construction" is an argument,
    // not a guarantee, and a curation view people stop reading discloses nothing.
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
    // The HEADER carries the true total — capping shortens the view, and must never understate the
    // population, which is the one thing this disclosure cannot afford to do.
    expect(rendered).toContain("7 deny(s) arrived with no reason");
    expect(rendered).toContain("gate-0  ·  Never run tool 0 unattended");
    expect(rendered).toContain("gate-4  ·  Never run tool 4 unattended");
    expect(rendered).not.toContain("gate-5  ·");
    expect(rendered).toContain("… and 2 more");
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
    expect(() => dst.graftRows({ ...payload, schemaVersion: 13 }))
      .toThrow(/this build understands up to 12/);
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
  const read = (path: string): BlockingSidecar => JSON.parse(readFileSync(path, "utf8")) as BlockingSidecar;

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
    // rename is real, not theoretical — see materializeBlockingSidecar's own comment and the dedicated
    // race test in "the sidecar generation contract" below, which pins THAT half. HERE, nothing else
    // is mutating: the fabricated file is ahead of the store's CURRENT generation too, with no
    // legitimate writer behind it, so it is debris of an abandoned lineage (a restore or a rollback) —
    // the same event class as the foreign case below — and it is overwritten.
    const newer = { ...current, generation: current.generation + 5, entries: [] };
    writeFileSync(path, JSON.stringify(newer), "utf8");
    const result = c.materializeBlockingSidecar(path);
    expect(result.outcome).toBe("written");
    expect(read(path).generation).toBe(current.generation); // the store's own count, not the fabricated one
    expect(read(path).entries).toHaveLength(1);              // the store's real deny, not the fabricated empty set
    expect(readdirSync(dir)).toEqual(["gate-sidecar.json"]);  // and no temp file left behind

    // A file from ANOTHER store is not ours to defer to either, however high its number — identity
    // already gated the preservation rule before generation did, and still does.
    writeFileSync(path, JSON.stringify({ ...newer, storeIdentity: "machine-b" }), "utf8");
    c.materializeBlockingSidecar(path);
    expect(read(path).storeIdentity).toBe("machine-a");
    expect(read(path).entries).toHaveLength(1);
    c.close();
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

describe("the sidecar generation contract", () => {
  const read = (path: string): BlockingSidecar => JSON.parse(readFileSync(path, "utf8")) as BlockingSidecar;

  it("bumps exactly once per mutation class, and not at all for unrelated writes", async () => {
    const c = resolvingCore();
    const at = (): number => c.sidecarGeneration();
    const start = at();

    // An advisory rule is not deny power: nothing to mirror, nothing to bump.
    await c.store("An advisory rule.", { kind: "rule", rule: { stage: "rm -rf", instance: "Bash:rm -rf", ...AGENT_RULE } });
    await c.store("An ordinary fact.", { kind: "fact" });
    expect(at()).toBe(start);

    // 1. a blocking binding appears
    const deny = await c.declare({
      species: "rule", stage: "terraform apply", patterns: ["terraform apply"],
      content: "Never apply without a plan review.", severity: "blocking",
      reason: "an unreviewed apply changes infrastructure nobody agreed to change", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    const afterDeclare = at();
    expect(afterDeclare).toBe(start + 1);

    // 2. patterns change on a stage that carries a deny
    await c.declare({
      species: "stage", stage: "terraform apply", patterns: ["terraform apply", "terraform destroy"],
      acknowledgeBlockingRules: [deny.conceptId],
    });
    const afterPatterns = at();
    expect(afterPatterns).toBe(afterDeclare + 1);
    // ...but a no-op re-declaration of the SAME patterns changes nothing, so it bumps nothing.
    await c.declare({
      species: "stage", stage: "terraform apply", patterns: ["terraform apply", "terraform destroy"],
      acknowledgeBlockingRules: [deny.conceptId],
    });
    expect(at()).toBe(afterPatterns);

    // 3. moving the rule between circles rewrites the entry's `circle` field
    c.reassignCircle(deny.conceptId, "elsewhere");
    const afterMove = at();
    expect(afterMove).toBe(afterPatterns + 1);

    // 4. an explicit downgrade — the only way to take deny power off a live rule
    await withdrawDeny(c, deny.conceptId, "terraform apply", "elsewhere");
    const afterDowngrade = at();
    expect(afterDowngrade).toBe(afterMove + 1);

    // 5. retire, now that the deny has been withdrawn and retirement is ordinary cleanup. Bumps
    //    nothing further: the rule stopped being in the mirror at the downgrade.
    c.retireConcept(deny.conceptId);
    expect(at()).toBe(afterDowngrade);
    // ...and now that nothing blocks, an ordinary rule write moves nothing at all.
    const settled = at();
    await c.store("Another advisory rule.", { kind: "rule", rule: { stage: "rm -rf", ...AGENT_RULE } });
    c.retireConcept((await c.store("A throwaway fact.", { kind: "fact" })).conceptId);
    expect(at()).toBe(settled);
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
    expect(c.sidecarGeneration()).toBe(before + 1);
    // The mirror names each rule's circle, so the rename really did change the file's content.
    expect(c.materializeBlockingSidecar(join(mkTmp(), "s.json")).sidecar.entries[0]!.circle).toBe("project-renamed");

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
    // No further bump: the rule left the mirror at the withdrawal, not at the supersession.
    expect(c.sidecarGeneration()).toBe(beforeSupersede);
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

    // BEHIND — the file's own header is what makes this detectable at all.
    const stale = read(path);
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
    writeFileSync(path, JSON.stringify({ ...current, format: 2 }), "utf8");
    expect(c.isSidecarStale()).toMatchObject({
      stale: true, reason: "format", fileFormat: 2, format: 3, fileGeneration: current.generation,
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
   * there is no meaning between format 3 and format 4 — so `3.5` is not "a number ahead of ours",
   * it is a corrupt header. Before this fix it classified exactly like a genuine future build's file:
   * `format-ahead` here, and `skipped-format-ahead` forever from materializeBlockingSidecar, preserved
   * on the promise of an upgrade that would never arrive, since no build — past or future — will ever
   * actually write format 3.5. Same permanent-strand shape as the round-9 generation finding, one
   * field over.
   */
  it("treats a FRACTIONAL format as malformed, not as a future format to defer to", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const current = read(path);

    const fractional = { ...current, format: 3.5 };
    writeFileSync(path, JSON.stringify(fractional), "utf8");
    // NOT format-ahead: the whole header is rejected at the read seam, so this is indistinguishable
    // from any other structurally-wrong file — same reason, same fileGeneration: null.
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "malformed", fileGeneration: null });

    const result = c.materializeBlockingSidecar();
    expect(result.outcome).toBe("written"); // regenerated, not preserved as an unreadable "future" shape
    expect(read(path).format).toBe(3);
    expect(read(path).entries).toHaveLength(1);
    expect(c.isSidecarStale().stale).toBe(false);
    c.close();
  });

  it("REWRITES a stale-shaped mirror even though the generation has not moved", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = await withDeny(path);
    const current = read(path);

    // Downgrade the file in place and change nothing else. Before format joined the replace
    // decision, the skip-if-not-newer guard fired here and the v2 artifact survived indefinitely.
    writeFileSync(path, JSON.stringify({ ...current, format: 2 }), "utf8");
    expect(c.sidecarGeneration()).toBe(current.generation); // nothing about the store has changed

    c.materializeBlockingSidecar();
    expect(read(path).format).toBe(3);
    expect(read(path).entries[0]).toMatchObject({ reasonMissing: false });
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

    c.materializeBlockingSidecar();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(fromTheFuture); // untouched, byte for byte

    // ...and NOT a silent no-op: the operator asking gets the direction of the skew, not just "bad".
    expect(c.isSidecarStale()).toMatchObject({
      stale: true, reason: "format-ahead", fileFormat: 99, format: 3,
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

    c.materializeBlockingSidecar();

    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.format).toBe(3);
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
    // changed or is about to. Before this, the next reader was a v3 hook rejecting a v2 file.
    writeFileSync(path, JSON.stringify({ ...current, format: 2 }), "utf8");

    const reopened = new MonetCore(":memory:", {
      tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, syncDeviceId: "machine-a",
    });
    // NOT a declaration, NOT a gate, NOT a graft — the constructor returning is the whole event.
    expect(read(path).format).toBe(3);
    expect(reopened.isSidecarStale().stale).toBe(false);
    reopened.close();
  });

  /**
   * A WRITER THAT SAYS IT WROTE WHEN IT DID NOT is the same lie this module spends its length
   * preventing everywhere else. materializeBlockingSidecar returned the freshly generated,
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

    const result = c.materializeBlockingSidecar();
    expect(result.outcome).toBe("skipped-format-ahead");
    // The generated mirror is still handed back — it is what WOULD have been written, and reading
    // it is legitimate. What is no longer possible is mistaking it for the file on disk.
    expect(result.sidecar.format).toBe(3);
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
    const noop = c.materializeBlockingSidecar();
    expect(noop.outcome).toBe("skipped-current");
    expect(c.isSidecarStale().stale).toBe(false);

    // Recovery after the file is lost — the other documented reason this method is public. Here the
    // write really happens, and "written" is what entitles the caller to report a repaired mirror.
    rmSync(path);
    const written = c.materializeBlockingSidecar();
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
   * materializeBlockingSidecar's own comment for the full split. This pins the ROLLBACK half: no
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

    const result = c.materializeBlockingSidecar();
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
      result = c.materializeBlockingSidecar();
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
    // the test that fails if materializeBlockingSidecar's guard is removed. This one fails if the
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
    writeFileSync(path, JSON.stringify({ ...current, format: 2 }), "utf8");

    // `deferCreatedPin` is the EXISTING declaration that this caller is inspection or dry-run
    // tooling which must never write anything — the same flag that already stops a pin being minted.
    // Opening a store to LOOK at it must not mutate the installation being looked at.
    const inspector = new MonetCore(":memory:", {
      tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, syncDeviceId: "machine-a",
      deferCreatedPin: true,
    });
    expect(read(path).format).toBe(2);
    // It can still SAY the mirror is stale — reporting is what this mode is for.
    expect(inspector.isSidecarStale()).toMatchObject({ stale: true, reason: "format" });
    // And an EXPLICIT call is the caller asking, which the suppression does not countermand.
    expect(inspector.materializeBlockingSidecar().outcome).toBe("written");
    expect(read(path).format).toBe(3);
    inspector.close();

    // The served runtime, for contrast: same file, same staleness, repaired by opening.
    writeFileSync(path, JSON.stringify({ ...current, format: 2 }), "utf8");
    const served = new MonetCore(":memory:", {
      tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, syncDeviceId: "machine-a",
    });
    expect(read(path).format).toBe(3);
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

    // B1's over-block case: withdrawing the deny must take it OUT of the file, without anyone
    // remembering to re-materialize. Retirement alone is refused now, so the withdrawal is the
    // declaration and the retire is cleanup afterwards.
    await withdrawDeny(c, deny.conceptId, "rm -rf");
    expect(read(path).entries).toEqual([]);
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
    await expect(
      c.declare({ species: "rule", stage: "ws2", content: "Text.", scope: "agent", modelTag: "\t \n" }),
    ).rejects.toThrow(/requires rule\.modelTag/);
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
      conceptId: rule.conceptId, stageId, scope: "agent", modelTag: overLong, origin: "correction",
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
        `INSERT INTO rule_bindings (concept_id, stage_id, severity, scope, model_tag, origin, created_at, sync_updated_at, sync_revision)
         VALUES (?, ?, 'advisory', 'domain', NULL, 'import', ?, ?, 0)`,
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

  async function harness(c: MonetCore, opts: { modelTag?: string } = {}) {
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, c, { autoPrewarm: false, checkpointNudge: false, ...opts });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await client.connect(ct);
    const call = async (tool: string, args: Record<string, unknown>): Promise<{ json: Record<string, unknown>; isError: boolean; text: string }> => {
      const r = (await client.callTool({ name: tool, arguments: args })) as McpContent;
      const text = r.content[0]!.text;
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // An error response is prose, not JSON — the caller asserts on `text` instead.
      }
      return { json, isError: r.isError === true, text };
    };
    return { call, client };
  }

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
    expect(Object.keys(ruleSchema.properties ?? {}).sort()).toEqual(["instance", "modelTag", "reason", "scope", "stage"]);
    // ...while memory_declare does carry it, and says so.
    const declare = tools.find((t) => t.name === "memory_declare")!;
    expect(Object.keys(declare.inputSchema.properties as object)).toContain("severity");
    expect(declare.description).toMatch(/blocking/);
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
