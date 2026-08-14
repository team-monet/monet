/**
 * Non-Latin concept slugs (#187) and the one-time repair for stores an older build already damaged.
 *
 * WHY THIS MATTERS BEYOND APPEARANCE: `concepts.slug` is a lookup key, not a label. `resolveRef`
 * resolves a `supports: #ref` assertion with `WHERE circle=? AND slug=? ... LIMIT 1`, so when every
 * non-Latin concept in a circle carried the SAME empty slug, such an assertion did not fail — it
 * landed on an arbitrary wrong concept and materialized a wrong edge.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore, slugify } from "../engine";
import { HashingEmbeddingProvider } from "../embedding";

const dirs: string[] = [];
function tempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "monet-slug-nonlatin-"));
  dirs.push(dir);
  return join(dir, "monet.db");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("slugify — every script produces a slug", () => {
  it("no longer collapses a wholly non-Latin title to the empty string", () => {
    expect(slugify("주식 트래커 포트폴리오")).not.toBe("");
    expect(slugify("株式トラッカー")).not.toBe("");
    expect(slugify("股票追踪器")).not.toBe("");
    expect(slugify("Портфель трекера")).not.toBe("");
    expect(slugify("محفظة متتبع")).not.toBe("");
  });

  it("keeps the non-Latin part of a MIXED title instead of dropping it", () => {
    // The old rule kept only the Latin fragment, so the Korean simply vanished from the key.
    expect(slugify("한국어 English 혼합")).toContain("한국어");
    expect(slugify("한국어 English 혼합")).toContain("english");
  });

  it("gives DIFFERENT non-Latin titles DIFFERENT slugs — the property resolveRef depends on", () => {
    // Both were "" before, which is why a `supports: #ref` assertion could not tell them apart.
    const a = slugify("주식 트래커");
    const b = slugify("클리어런스 딜 리뷰");
    expect(a).not.toBe(b);
    expect(a).not.toBe("");
    expect(b).not.toBe("");
  });

  it("leaves ASCII titles byte-identical to what the old rule produced", () => {
    expect(slugify("Librarian layer design: monet-core 0.5.0")).toBe("librarian-layer-design-monet-core-0-5-0");
    expect(slugify("  leading and trailing  ")).toBe("leading-and-trailing");
    expect(slugify("!!!___...punctuation only...___!!!")).toBe("punctuation-only");
    expect(slugify("")).toBe("");
  });

  it("still yields the empty string when a title holds no letters or digits in ANY script", () => {
    expect(slugify("!!! ... ---")).toBe("");
  });

  it("keeps combining marks, which in an abugida ARE the vowels (Codex review, PR #189)", () => {
    // Dropping \p{M} recreated the very collision this function was changed to remove: all three
    // of these became "द-न", three distinct titles sharing one lookup key.
    const hindi = ["दिन", "दान", "दीन"].map(slugify);
    expect(new Set(hindi).size).toBe(3);
    for (const s of hindi) expect(s).not.toBe("द-न");
  });

  it("caps at 60 CODE POINTS, never splitting a surrogate pair (Codex review, PR #189)", () => {
    // A supplementary-plane letter is two UTF-16 units, so a unit-based slice could end the slug on
    // a lone high surrogate — not valid UTF-8, so the key would be mangled in storage and could not
    // round-trip through resolveRef.
    const long = "a" + "𐐀".repeat(40); // Deseret, all supplementary plane
    const slug = slugify(long);
    expect(/[\uD800-\uDBFF]$/.test(slug)).toBe(false);
    expect([...slug].length).toBeLessThanOrEqual(60);
    expect(Buffer.from(slug, "utf8").toString("utf8")).toBe(slug); // round-trips cleanly
  });

  it("normalizes so a composed and a decomposed spelling produce ONE key", () => {
    const composed = "caf" + String.fromCharCode(0x00e9);     // e-acute as one code point
    const decomposed = "cafe" + String.fromCharCode(0x0301);  // e + combining acute
    expect(composed).not.toBe(decomposed);
    expect(slugify(composed)).toBe(slugify(decomposed));
  });
});

describe("asserted references can actually USE a non-Latin slug (Codex review, PR #189)", () => {
  it("resolves `supports: #<korean-slug>` to the right concept, end to end", async () => {
    // The whole argument for changing slugify was that they are lookup keys for resolveRef. That
    // was worth nothing while ASSERTED_RE's `\w` — ASCII in JavaScript — meant a Unicode reference
    // never reached resolveRef at all. This is the first test that exercises the complete path:
    // title -> slug -> written reference -> parsed -> resolved -> edge.
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    const target = await core.store("주식 트래커 포트폴리오를 정리하는 방법");
    const slug = (await core.getConcept(target.conceptId))!.slug;
    expect(slug).not.toBe("");
    expect(/[가-힣]/.test(slug)).toBe(true); // the slug really is Korean, not a Latin remnant

    // forceNew, deliberately: under the lexical test embedder the two Korean texts score similar
    // enough to ATTACH, leaving one concept with nothing to point at. That would make this test
    // fail for a reason having nothing to do with reference parsing — which is what it did first.
    const referrer = await core.store(`이 작업을 끝냈다. supports: #${slug}`, { resolution: "forceNew" });
    const supports = core.edges({ type: "supports" });
    expect(supports.some((e) => e.srcId === referrer.conceptId && e.dstId === target.conceptId)).toBe(true);
    core.close();
  });
});

describe("empty-slug repair — heals stores an older build damaged", () => {
  it("fills an empty slug from the title on the next open, and is idempotent", () => {
    const path = tempStore();
    const open = (): MonetCore => new MonetCore(path, { embedder: new HashingEmbeddingProvider() });

    let core = open();
    // Fabricate exactly what an older build left behind: a real title, an empty slug.
    (core as any).db
      .prepare(`INSERT INTO concepts (id, slug, title, body, kind, embedding) VALUES (?,?,?,?,?,?)`)
      .run("korean-1", "", "주식 트래커 포트폴리오", "body", "fact", JSON.stringify([0.01, 0.02]));
    core.close();

    core = open(); // constructor runs the repair
    const afterFirst = (core as any).db.prepare(`SELECT slug FROM concepts WHERE id=?`).get("korean-1") as { slug: string };
    expect(afterFirst.slug).toBe(slugify("주식 트래커 포트폴리오"));
    expect(afterFirst.slug).not.toBe("");
    core.close();

    core = open(); // second open must not churn it
    const afterSecond = (core as any).db.prepare(`SELECT slug FROM concepts WHERE id=?`).get("korean-1") as { slug: string };
    expect(afterSecond.slug).toBe(afterFirst.slug);
    core.close();
  });

  it("does not clobber a slug another writer changed between the read and the write", () => {
    // `broken` is selected before the transaction opens, so a concurrent title+slug update would
    // otherwise be overwritten by a slug derived from the title this process read — leaving slug
    // and title inconsistent (Codex review, PR #189). Simulated by making the row no longer match
    // what was selected: the write must become a no-op rather than win.
    const path = tempStore();
    const open = (): MonetCore => new MonetCore(path, { embedder: new HashingEmbeddingProvider() });

    let core = open();
    (core as any).db
      .prepare(`INSERT INTO concepts (id, slug, title, body, kind, embedding) VALUES (?,?,?,?,?,?)`)
      .run("raced", "", "주식 트래커", "body", "fact", JSON.stringify([0.01]));
    core.close();

    // Another writer renames it and gives it a slug BEFORE this process opens.
    const raw = new (require("better-sqlite3"))(path);
    raw.prepare(`UPDATE concepts SET title=?, slug=? WHERE id=?`).run("Renamed By Someone Else", "renamed-by-someone-else", "raced");
    raw.close();

    core = open();
    const row = (core as any).db.prepare(`SELECT slug, title FROM concepts WHERE id=?`).get("raced") as { slug: string; title: string };
    expect(row.slug).toBe("renamed-by-someone-else"); // the other writer's slug survives
    expect(row.title).toBe("Renamed By Someone Else");
    core.close();
  });

  it("NEVER rewrites a slug that is already non-empty, even a stale one", () => {
    // Measured on the dogfood store: 131 of 680 concepts carry a slug that does not match
    // slugify(title) for reasons unrelated to #187. A blanket recompute would rewrite all of them,
    // and a live slug is a reference key. This pins the repair to empty slugs only.
    const path = tempStore();
    const open = (): MonetCore => new MonetCore(path, { embedder: new HashingEmbeddingProvider() });

    let core = open();
    (core as any).db
      .prepare(`INSERT INTO concepts (id, slug, title, body, kind, embedding) VALUES (?,?,?,?,?,?)`)
      .run("stale-1", "a-slug-from-an-older-title", "A Completely Different Title Now", "body", "fact", JSON.stringify([0.01]));
    core.close();

    core = open();
    const row = (core as any).db.prepare(`SELECT slug FROM concepts WHERE id=?`).get("stale-1") as { slug: string };
    expect(row.slug).toBe("a-slug-from-an-older-title");
    core.close();
  });

  it("normalizes an empty slug arriving by GRAFT, not only at construction (Codex review, PR #189)", async () => {
    // The constructor repair cannot help a long-running process: it already ran. A peer still on an
    // older build relays its empty slug, graftRows stored it verbatim, and the ambiguous lookup key
    // survived until restart. Simulating exactly that — a payload whose slug is "" — is what pins
    // the derivation at the graft site.
    const src = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    const dst = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    const stored = await src.store("주식 트래커 포트폴리오를 정리한 개념");

    const payload = src.exportDelta(0);
    const row = payload.concepts.find((r: { id: string }) => r.id === stored.conceptId) as { id: string; slug: string; title: string };
    expect(row).toBeTruthy();
    row.slug = ""; // what a peer on an older build would have sent
    await dst.graftRows(payload);

    const landed = (dst as any).db.prepare(`SELECT slug FROM concepts WHERE id=?`).get(stored.conceptId) as { slug: string };
    expect(landed.slug).toBe(slugify(row.title));
    expect(landed.slug).not.toBe("");
    src.close();
    dst.close();
  });

  it("leaves an empty slug alone when the title cannot produce one, rather than churning every open", () => {
    const path = tempStore();
    const open = (): MonetCore => new MonetCore(path, { embedder: new HashingEmbeddingProvider() });

    let core = open();
    (core as any).db
      .prepare(`INSERT INTO concepts (id, slug, title, body, kind, embedding) VALUES (?,?,?,?,?,?)`)
      .run("punct-1", "", "!!! ... ---", "body", "fact", JSON.stringify([0.01]));
    core.close();

    core = open();
    const row = (core as any).db.prepare(`SELECT slug FROM concepts WHERE id=?`).get("punct-1") as { slug: string };
    expect(row.slug).toBe("");
    core.close();
  });
});
