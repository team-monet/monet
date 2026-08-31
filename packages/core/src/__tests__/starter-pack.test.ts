/**
 * THE STARTER PACK, RUN RATHER THAN READ.
 *
 * Phase 5 of `harness/bootstrap/install.md` hands a user with no standing file a small default set
 * and declares what they approve. Its rule half was broken three independent ways, and every one was
 * found by review rather than by a test:
 *
 *   - `scope` defaulted to `agent`, which `memory_declare` refuses without a `MONET_MODEL_TAG` that
 *     the documented install never sets — so the declaration threw outright.
 *   - Breadth was unspecified, so every entry bound to whatever circle the install ran in and
 *     reached no other project.
 *   - `memory_ratify` was prescribed for all six entries, and it throws on a rule id.
 *
 * ALL THREE LIVED IN THE PROSE SAYING HOW TO DECLARE, not in the entry list. That is why this reads
 * `starter-pack.json` instead of parsing the markdown: a test that took the entries from the doc and
 * chose the arguments itself would have passed however wrong the playbook was — a green that cannot
 * fail. The arguments have to come from the artifact under test.
 *
 * The doc stays authoritative for a human. `the doc and the data say the same thing` below fails if
 * they diverge in either direction, which is what keeps one file from being quietly right while the
 * other ships.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MonetCore } from "../engine";

const PACK_PATH = join(__dirname, "../../../../harness/bootstrap/starter-pack.json");
const INSTALL_PATH = join(__dirname, "../../../../harness/bootstrap/install.md");

type Entry = {
  species: "principle" | "rule";
  circle: string;
  scope?: "domain" | "agent";
  severity?: "advisory" | "blocking";
  stage?: string;
  ratify: boolean;
  content: string;
  reason: string;
};

const pack = JSON.parse(readFileSync(PACK_PATH, "utf8")) as { entries: Entry[] };
const install = readFileSync(INSTALL_PATH, "utf8");

const cores: MonetCore[] = [];
afterEach(() => {
  for (const core of cores.splice(0)) core.close();
});

/** A store as a fresh install has it: no stages, no model tag, one circle. */
function freshInstall(): MonetCore {
  const core = new MonetCore(":memory:", { defaultCircle: "the-install-circle", tauAttach: 1.1, tauAmbiguous: 1.1 });
  cores.push(core);
  return core;
}

async function declareEntry(core: MonetCore, entry: Entry): Promise<string> {
  const result = await core.declare({
    species: entry.species,
    circle: entry.circle,
    content: entry.content,
    declaredBy: "the user (starter pack)",
    ...(entry.species === "rule" ? { stage: entry.stage, scope: entry.scope, severity: entry.severity, reason: entry.reason } : {}),
  });
  // `declare` returns a union whose stage variant carries no concept. The pack declares no stages —
  // a rule brings its own — so reaching that branch means the data grew a species this test does not
  // cover, and saying so beats letting a cast hide it.
  if (!("conceptId" in result)) throw new Error(`starter-pack entry declared no concept: ${entry.content.slice(0, 48)}`);
  return result.conceptId;
}

describe("the starter pack declares cleanly on a fresh install", () => {
  it("every entry lands, with no model tag configured", async () => {
    const core = freshInstall();
    // THE CONDITION THAT BROKE IT. `memory_declare` defaults an unspecified scope to `agent` and
    // refuses an agent-scoped rule with no modelTag; the Phase 3 config sets no MONET_MODEL_TAG, and
    // this store has none either. An entry missing `scope: "domain"` throws here rather than
    // silently degrading, which is exactly what shipped.
    expect(core.getRuntimeModelTag?.() ?? null).toBeNull();
    for (const entry of pack.entries) {
      await expect(declareEntry(core, entry), `entry did not declare: ${entry.content.slice(0, 48)}`).resolves.toBeTruthy();
    }
  });

  it("ratification is accepted for the principles and refused for the rules", async () => {
    const core = freshInstall();
    for (const entry of pack.entries) {
      const conceptId = await declareEntry(core, entry);
      const ratifying = core.ratify({ candidateId: conceptId, circle: "the-install-circle", verdict: "approve", entrance: "declaration" });
      if (entry.ratify) {
        await expect(ratifying).resolves.toBeTruthy();
      } else {
        // BOTH DIRECTIONS ASSERTED. Without this half the `ratify: false` flag could be wrong in the
        // data and nothing would notice — which is the shape of the original bug, where the playbook
        // prescribed ratify for all six.
        await expect(ratifying).rejects.toThrow(/not 'principle' or 'preference'/);
      }
    }
    expect(pack.entries.filter((e) => e.ratify)).toHaveLength(2);
  });

  it("reaches a circle the install never ran in", async () => {
    const core = freshInstall();
    const idOf = new Map<Entry, string>();
    for (const entry of pack.entries) {
      const conceptId = await declareEntry(core, entry);
      idOf.set(entry, conceptId);
      if (entry.ratify) await core.ratify({ candidateId: conceptId, circle: "the-install-circle", verdict: "approve", entrance: "declaration" });
    }

    // THE USER'S SECOND PROJECT. A default that reaches one project is not a default, and every
    // entry was confined to the install circle before #142.
    const elsewhere = "a-project-opened-later";
    // BY ID, NOT BY TEXT. A skeleton member carries the concept's TITLE, which is clipped with an
    // ellipsis — matching on content would fail on a long entry and, worse, could be "fixed" by
    // comparing a prefix, which then passes for any entry sharing an opening clause.
    const skeleton = core.overview(elsewhere).skeleton.map((m) => m.conceptId);
    for (const entry of pack.entries.filter((e) => e.species === "principle")) {
      expect(skeleton, `principle did not travel: ${entry.content.slice(0, 40)}`).toContain(idOf.get(entry));
    }
    for (const entry of pack.entries.filter((e) => e.species === "rule")) {
      const rules = core.stageLookup({ stage: entry.stage!, circle: elsewhere }).rules ?? [];
      expect(rules.map((r) => r.body), `rule did not travel: ${entry.stage}`).toContain(entry.content);
    }
  });

  it("a rule entry is complete at declare — no ratify needed for it to fire", async () => {
    const core = freshInstall();
    const rule = pack.entries.find((e) => e.species === "rule")!;
    await declareEntry(core, rule);
    // The playbook says a rule is done after `memory_declare`. If that were wrong, the entry would
    // be dead in every circle including its own, and the ratify test above would be the only cover.
    const here = core.stageLookup({ stage: rule.stage!, circle: "the-install-circle" }).rules ?? [];
    expect(here.map((r) => r.body)).toContain(rule.content);
  });
});

describe("the doc and the data say the same thing", () => {
  /** The run of pack bullets, between the two headings that bracket the list. */
  function packBullets(): string[] {
    const section = install.slice(install.indexOf("If they have nothing — offer the starter pack"), install.indexOf("## Phase 6"));
    return section.split("\n").filter((line) => /^- \*\*(Principle|Rule at )/.test(line));
  }

  it("every entry in the data appears in the playbook", () => {
    for (const entry of pack.entries) {
      // Collapse the doc's hard wrapping before matching, so a rewrap is not a failure.
      const flat = install.replace(/\s+/g, " ");
      expect(flat, `missing from install.md: ${entry.content.slice(0, 48)}`).toContain(entry.content.replace(/\s+/g, " "));
      expect(flat, `reason missing from install.md: ${entry.reason.slice(0, 40)}`).toContain(entry.reason.replace(/\s+/g, " "));
    }
  });

  it("every rule bullet names the stage and severity the data carries", () => {
    // THE PART THE OTHER TWO MISS. Content and reason are compared above, and the shared arguments
    // below, but `stage` and `severity` live per-entry on the bullet's own first line. Change a
    // stage in the data alone and everything else stays green: the behavioural tests declare
    // happily at any stage, and nothing compares it to the prose — the same green-that-cannot-fail
    // this whole file exists against.
    const bullets = packBullets();
    const fromDoc = bullets
      .map((line) => /^- \*\*Rule at "([^"]+)" \((advisory|blocking)\)\*\*/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => `${m[1]}/${m[2]}`)
      .sort();
    const fromData = pack.entries
      .filter((e) => e.species === "rule")
      .map((e) => `${e.stage}/${e.severity}`)
      .sort();

    // PRESENT FIRST: an empty parse would otherwise satisfy an equality against an empty list.
    expect(fromDoc.length).toBe(pack.entries.filter((e) => e.species === "rule").length);
    expect(fromDoc).toEqual(fromData);
  });

  it("the playbook has no pack entry the data does not carry", () => {
    const bullets = packBullets();
    expect(bullets).toHaveLength(pack.entries.length);
    // AND THE SPLIT MATCHES, not just the count — two principles and four rules, so a rule silently
    // rewritten as a principle in one file and not the other is caught.
    expect(bullets.filter((b) => b.startsWith("- **Principle"))).toHaveLength(
      pack.entries.filter((e) => e.species === "principle").length,
    );
  });

  it("the arguments the prose prescribes are the ones the data carries", () => {
    const flat = install.replace(/\s+/g, " ");
    expect(flat).toContain('Declare **every** entry with `circle: "*"`');
    expect(pack.entries.every((e) => e.circle === "*")).toBe(true);
    expect(flat).toContain('Declare every **rule** entry with `scope: "domain"`');
    expect(pack.entries.filter((e) => e.species === "rule").every((e) => e.scope === "domain")).toBe(true);
    expect(flat).toContain("**for the two principle entries only**");
    expect(pack.entries.filter((e) => e.ratify).every((e) => e.species === "principle")).toBe(true);
  });
});
