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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MonetCore } from "../engine";
import { registerMonetCoreTools } from "../mcp-server";
import { renderOverview } from "../render-overview";
import {
  COMMAND_BOUNDARY,
  formatTriggerPattern,
  readTriggerPatterns,
  upsertStage,
  matchesTriggerPattern,
  normalizeMatchToken,
  parseActionContext,
  parseTriggerPatterns,
  seedTriggerPattern,
} from "../gates";
import type { BlockingSidecar } from "../gates";
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
      severity: "blocking", declaredBy: "john", ...AGENT_RULE,
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
      severity: "blocking", ...AGENT_RULE,
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
      content: "Never force-push to main.", severity: "blocking", ...AGENT_RULE,
    });
    expect(read(path).entries.map((e) => e.stageName)).toEqual(["git force push", "rm -rf"]);

    // The mirror follows the store — but a live deny cannot simply be retired any more (the
    // chokepoint refuses), so withdrawing it is a declaration first and ordinary cleanup after.
    expect(() => c.retireConcept(declared.conceptId)).toThrow(/would remove the blocking rule/);
    await withdrawDeny(c, declared.conceptId, "rm -rf");
    c.retireConcept(declared.conceptId);
    expect(c.materializeBlockingSidecar().entries.map((e) => e.stageName)).toEqual(["git force push"]);
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
      severity: "blocking", ...AGENT_RULE,
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
    });
    await c.declare({
      species: "rule", stage: "rm -rf",
      content: "Deleting a tree is irreversible.", severity: "blocking", scope: "domain",
    });
    if (compensation.species !== "rule") throw new Error("unreachable");

    const sidecar = read(path);
    expect(sidecar.format).toBe(2);
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
      species: "rule", stage: "rm -rf", content: "Never delete a tree unattended.", severity: "blocking", ...AGENT_RULE,
    });
    // No gateSidecarPath: a MonetCore must never write into somebody's real store directory just
    // because it was constructed.
    expect(existsSync(path)).toBe(false);
    expect(() => c.materializeBlockingSidecar()).toThrow(/needs a path/);

    const sidecar = c.materializeBlockingSidecar(path);
    expect(sidecar.entries).toHaveLength(1);
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
      species: "rule", stage: "git force push", content: "Never force-push to main.", severity: "blocking", ...AGENT_RULE,
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
      species: "rule", stage: "git force push", content: "Never force-push to main.", severity: "blocking", ...AGENT_RULE,
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
      severity: "blocking", ...AGENT_RULE,
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
      content: "Never delete a tree unattended.", severity: "blocking", ...AGENT_RULE,
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
      content: "Never delete a directory tree unattended.", severity: "blocking", ...AGENT_RULE,
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

  it("refuses to replace a sidecar that is already at or ahead of what we are writing", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, syncDeviceId: "machine-a" });
    await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", ...AGENT_RULE,
    });
    const current = read(path);

    // rename() is atomic, but atomic is not ordered: a racing writer can land an OLDER snapshot on
    // top of a newer one, and its generation then sits in the header claiming to be current — worse
    // than staleness, because inspectSidecar would agree with it.
    const newer = { ...current, generation: current.generation + 5, entries: [] };
    writeFileSync(path, JSON.stringify(newer), "utf8");
    c.materializeBlockingSidecar(path);
    expect(read(path).generation).toBe(current.generation + 5); // not clobbered
    expect(readdirSync(dir)).toEqual(["gate-sidecar.json"]);    // and no temp file left behind

    // A file from ANOTHER store is not ours to defer to, however high its number.
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
      content: "Never delete a tree unattended.", severity: "blocking", ...AGENT_RULE,
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
      content: "Never delete a tree unattended.", severity: "blocking", ...AGENT_RULE,
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
      content: "Never delete a tree unattended.", severity: "blocking", ...AGENT_RULE,
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
      content: "Never apply without a plan review.", severity: "blocking", ...AGENT_RULE,
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
      content: "Never delete a tree unattended.", severity: "blocking", ...AGENT_RULE,
    });
    if (deny.species !== "rule") throw new Error("unreachable");
    const before = c.sidecarGeneration();
    c.renameCircle("proj", "project-renamed");
    expect(c.sidecarGeneration()).toBe(before + 1);
    // The mirror names each rule's circle, so the rename really did change the file's content.
    expect(c.materializeBlockingSidecar(join(mkTmp(), "s.json")).entries[0]!.circle).toBe("project-renamed");

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

    // MISSING is stale — the hook's question is "can I trust this to decide a deny", and for a file
    // that is not there the answer is no.
    expect(c.isSidecarStale()).toMatchObject({ stale: true, reason: "missing", fileGeneration: null });

    const deny = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", ...AGENT_RULE,
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

  it("auto-re-materializes from every mutation point when a path is configured", async () => {
    const dir = mkTmp();
    const path = join(dir, "gate-sidecar.json");
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path });
    const deny = await c.declare({
      species: "rule", stage: "rm -rf", patterns: ["Bash:rm -rf"],
      content: "Never delete a tree unattended.", severity: "blocking", ...AGENT_RULE,
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
      content: "Never delete a tree unattended.", severity: "blocking", ...AGENT_RULE,
    });
    expect(mine.isSidecarStale().stale).toBe(false);

    // A restored backup, a copied database, or a path a second store was pointed at. A generation
    // counts ONE store's mutations, so comparing it across stores compares nothing — and two stores
    // land on the same small integer constantly. This is the strongest form of the stale-mirror
    // failure: not a missing deny, somebody else's deny.
    const theirs = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, gateSidecarPath: path, syncDeviceId: "machine-b" });
    await theirs.declare({
      species: "rule", stage: "other gate", patterns: ["Bash:other"],
      content: "A rule from another store entirely.", severity: "blocking", ...AGENT_RULE,
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
      content: "Never delete a tree unattended.", severity: "blocking", ...AGENT_RULE,
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
      content: "Never delete a tree unattended.", severity: "blocking", ...AGENT_RULE,
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
      content: "Never delete a directory tree unattended.", severity: "blocking", declaredBy: "john",
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
